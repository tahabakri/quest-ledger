import type { Message } from 'discord.js';
import type { BindStore } from '../binds.js';
import type { AppConfig, ChannelConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { QuestMatcher } from '../matcher.js';
import {
  type AttachmentInfo,
  type Outcome,
  type WarningKey,
  buildSubmissionRow,
  classifyImageMessage,
  classifyLinkMessage,
  isImageAttachment,
} from '../submissions.js';
import type { SheetWriter } from '../writer.js';

/** The slice of a Discord message the handler needs; see fromDiscordMessage(). */
export interface IncomingMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  /** For messages in a thread or forum post: the channel the thread belongs to. */
  parentChannelId: string | null;
  /** The watched channel's name: the parent's, for messages in a thread. */
  channelName: string;
  authorId: string;
  authorUsername: string;
  /** Bots, webhooks and system messages are never submissions. */
  automated: boolean;
  content: string;
  createdAt: Date;
  url: string;
  attachments: AttachmentInfo[];
  react(emoji: string): Promise<unknown>;
  /** Replies in the channel, pinging only the author. */
  reply(content: string): Promise<{ delete(): Promise<unknown> }>;
}

export function fromDiscordMessage(message: Message): IncomingMessage {
  const channel = message.channel;
  const thread = channel.isThread() ? channel : null;
  const ownName = 'name' in channel && typeof channel.name === 'string' ? channel.name : '';
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId: thread?.parentId ?? null,
    channelName: thread?.parent?.name ?? ownName,
    authorId: message.author.id,
    authorUsername: message.author.username,
    automated: message.author.bot || message.webhookId !== null || message.system,
    content: message.content,
    createdAt: message.createdAt,
    url: message.url,
    attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url, contentType: a.contentType })),
    react: (emoji) => message.react(emoji),
    reply: (content) =>
      message.reply({
        content,
        allowedMentions: { users: [message.author.id], repliedUser: true },
        failIfNotExists: false,
      }),
  };
}

/** Deletes warning replies after a delay, and all at once on shutdown so none are left behind. */
export class WarningReaper {
  private readonly pending = new Map<NodeJS.Timeout, () => Promise<unknown>>();

  constructor(
    private readonly afterMs: number,
    private readonly log: Logger,
  ) {}

  schedule(remove: () => Promise<unknown>): void {
    if (this.afterMs <= 0) return;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      remove().catch((err: unknown) => this.log.warn('could not delete a warning reply', { err }));
    }, this.afterMs);
    this.pending.set(timer, remove);
  }

  async removeAllNow(): Promise<void> {
    const removals = [...this.pending.entries()];
    this.pending.clear();
    for (const [timer] of removals) clearTimeout(timer);
    await Promise.allSettled(removals.map(([, remove]) => remove()));
  }
}

interface HandlerDeps {
  config: Pick<AppConfig, 'channels' | 'replies' | 'reactions' | 'imageExtensions'>;
  guildId: string;
  matcher: QuestMatcher;
  binds: Pick<BindStore, 'lookup'>;
  writer: Pick<SheetWriter, 'record'>;
  reaper: WarningReaper;
  log: Logger;
}

export function createMessageHandler(deps: HandlerDeps) {
  const { config, log } = deps;
  const channels = new Map<string, ChannelConfig>(config.channels.map((c) => [c.id, c]));
  const warningText: Record<WarningKey, string> = config.replies;

  return async (message: IncomingMessage): Promise<void> => {
    // Only new messages reach here: edits arrive as a different event and are ignored.
    if (message.automated || message.guildId !== deps.guildId) return;
    // Threads (including forum posts) count as part of the channel they belong to.
    const channel =
      channels.get(message.channelId) ??
      (message.parentChannelId === null ? undefined : channels.get(message.parentChannelId));
    if (!channel) return;

    const bind = deps.binds.lookup(message.authorId);
    const bound = bind !== undefined;
    // Link channels record the link only; attachment_url stays blank for them.
    const image =
      channel.mode === 'image' ? message.attachments.find((a) => isImageAttachment(a, config.imageExtensions)) : undefined;
    const outcome: Outcome =
      channel.mode === 'image'
        ? classifyImageMessage({ text: message.content, hasImage: image !== undefined, bound }, deps.matcher)
        : classifyLinkMessage({ text: message.content, bound }, channel.questType);
    if (outcome.action === 'ignore') return;

    if (outcome.action === 'log') {
      const row = buildSubmissionRow(message, {
        questType: outcome.questType,
        fuzzy: outcome.fuzzy,
        attachmentUrl: image?.url ?? '',
        bind,
      });
      try {
        if (!deps.writer.record({ id: `sub:${message.id}`, kind: 'submission', row })) return; // seen before
      } catch (err) {
        // Last resort: the row goes to the host's logs so it can be recovered by hand.
        log.error('SUBMISSION NOT SAVED: write-ahead log failed', { err, row: JSON.stringify(row) });
        return;
      }
      log.info('submission logged', {
        message: message.id,
        user: message.authorId,
        questType: row.quest_type,
        fuzzy: row.fuzzy_match,
        bound: row.bound,
      });
    }

    await react(message, config.reactions[outcome.reaction], log);
    if (outcome.warnings.length > 0) {
      await warn(message, outcome.warnings.map((key) => warningText[key]), deps.reaper, log);
    }
  };
}

async function react(message: IncomingMessage, emoji: string, log: Logger): Promise<void> {
  try {
    await message.react(emoji);
  } catch (err) {
    log.warn('could not react (check Add Reactions and Read Message History permissions)', { message: message.id, err });
  }
}

async function warn(message: IncomingMessage, lines: string[], reaper: WarningReaper, log: Logger): Promise<void> {
  try {
    const reply = await message.reply(`<@${message.authorId}> ${lines.join('\n')}`);
    reaper.schedule(() => reply.delete());
  } catch (err) {
    log.warn('could not post a warning (check Send Messages permission)', { message: message.id, err });
  }
}
