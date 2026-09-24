import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindStore } from '../src/binds.js';
import { parseConfig } from '../src/config.js';
import { type IncomingMessage, WarningReaper, createMessageHandler } from '../src/discord/message-handler.js';
import { silentLogger } from '../src/logger.js';
import { QuestMatcher } from '../src/matcher.js';
import type { SubmissionRow } from '../src/sheets/schema.js';
import type { WalEntry } from '../src/wal.js';

const GUILD = '900000000000000001';
const IMAGE_CHANNEL = '111111111111111111';
const LINK_CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '333333333333333333';
const BOUND_USER = '100000000000000001';
const UNBOUND_USER = '100000000000000002';

const config = parseConfig(
  { text: readFileSync(new URL('../config.example.yml', import.meta.url), 'utf8'), origin: 'example' },
  { SUBMISSIONS_CHANNEL_ID: IMAGE_CHANNEL, LINKS_CHANNEL_ID: LINK_CHANNEL },
);

const PNG = { name: 'shot.png', url: 'https://cdn.example.com/shot.png', contentType: 'image/png' };
const PDF = { name: 'notes.pdf', url: 'https://cdn.example.com/notes.pdf', contentType: 'application/pdf' };

let messageId = 0;

function setup(options: { record?: (entry: WalEntry) => boolean } = {}) {
  const binds = new BindStore();
  binds.apply(binds.prepare(BOUND_USER, 'member_a', '123456', new Date('2026-01-01T00:00:00Z')));
  const recorded: WalEntry[] = [];
  const reaper = new WarningReaper(config.warningDeleteAfterSeconds * 1000, silentLogger);
  const handler = createMessageHandler({
    config,
    guildId: GUILD,
    matcher: new QuestMatcher(config.quests, config.fuzzyThreshold),
    binds,
    writer: {
      record: (entry) => {
        if (options.record) return options.record(entry);
        if (recorded.some((e) => e.id === entry.id)) return false;
        recorded.push(entry);
        return true;
      },
    },
    reaper,
    log: silentLogger,
  });
  const rows = () => recorded.map((e) => e.row as SubmissionRow);
  return { handler, recorded, rows, reaper };
}

function message(overrides: Partial<IncomingMessage> = {}) {
  const deleteReply = vi.fn(() => Promise.resolve());
  const react = vi.fn((_emoji: string) => Promise.resolve());
  const reply = vi.fn((_content: string) => Promise.resolve({ delete: deleteReply }));
  const id = `130000000000000${String(++messageId).padStart(4, '0')}`;
  const msg: IncomingMessage = {
    id,
    guildId: GUILD,
    channelId: IMAGE_CHANNEL,
    parentChannelId: null,
    channelName: 'submissions',
    authorId: BOUND_USER,
    authorUsername: 'member_a',
    automated: false,
    content: 'daily check-in',
    createdAt: new Date('2026-02-03T04:05:06.789Z'),
    url: `https://discord.com/channels/${GUILD}/${IMAGE_CHANNEL}/${id}`,
    attachments: [PNG],
    react,
    reply,
    ...overrides,
  };
  return { msg, react, reply, deleteReply };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('image channel', () => {
  it('logs image + keyword, reacts success, and says nothing', async () => {
    const { handler, rows } = setup();
    const { msg, react, reply } = message({ content: 'Daily Check-In ✅' });
    await handler(msg);
    expect(rows()).toEqual([
      {
        timestamp_utc: '2026-02-03T04:05:06Z',
        discord_user_id: BOUND_USER,
        discord_username: 'member_a',
        uid: '123456',
        bound: true,
        quest_type: 'daily_check_in',
        fuzzy_match: false,
        channel_name: 'submissions',
        message_text: 'Daily Check-In ✅',
        attachment_url: PNG.url,
        link_url: '',
        message_link: msg.url,
        date_utc: '2026-02-03',
      },
    ]);
    expect(react).toHaveBeenCalledWith('✅');
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(['DAILY CHECK-IN', 'Daily Check-In', 'done - daily check-in'])('matches %j regardless of case', async (content) => {
    const { handler, rows } = setup();
    await handler(message({ content }).msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'daily_check_in', fuzzy_match: false });
  });

  it('logs a typo as that quest with fuzzy_match = TRUE', async () => {
    const { handler, rows } = setup();
    const { msg, react } = message({ content: 'done - event attendence ✅' });
    await handler(msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'event_attendance', fuzzy_match: true });
    expect(react).toHaveBeenCalledWith('✅');
  });

  it('logs an unrelated caption as unmatched with the full text, and warns', async () => {
    const { handler, rows } = setup();
    const { msg, react, reply } = message({ content: 'here you go, as discussed yesterday' });
    await handler(msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'unmatched', fuzzy_match: false, message_text: 'here you go, as discussed yesterday' });
    expect(react).toHaveBeenCalledWith('❓');
    expect(reply).toHaveBeenCalledWith(`<@${BOUND_USER}> ${config.replies.unmatched}`);
  });

  it('does not log a keyword without an image, and asks for a screenshot', async () => {
    const { handler, recorded } = setup();
    const { msg, react, reply } = message({ attachments: [] });
    await handler(msg);
    expect(recorded).toHaveLength(0);
    expect(react).toHaveBeenCalledWith('❓');
    expect(reply).toHaveBeenCalledWith(`<@${BOUND_USER}> ${config.replies.noImage}`);
  });

  it('treats a non-image attachment as no image', async () => {
    const { handler, recorded } = setup();
    const { msg, reply } = message({ attachments: [PDF] });
    await handler(msg);
    expect(recorded).toHaveLength(0);
    expect(reply).toHaveBeenCalledWith(`<@${BOUND_USER}> ${config.replies.noImage}`);
  });

  it('records the first image, skipping other attachment types', async () => {
    const { handler, rows } = setup();
    await handler(message({ attachments: [PDF, PNG] }).msg);
    expect(rows()[0]?.attachment_url).toBe(PNG.url);
  });

  it('ignores chat with no keyword and no image', async () => {
    const { handler, recorded } = setup();
    const { msg, react, reply } = message({ content: 'what time is the event?', attachments: [] });
    await handler(msg);
    expect(recorded).toHaveLength(0);
    expect(react).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('still logs an unbound member (bound = FALSE, uid blank) and reminds them to /bind', async () => {
    const { handler, rows } = setup();
    const { msg, react, reply } = message({ authorId: UNBOUND_USER, authorUsername: 'member_b' });
    await handler(msg);
    expect(rows()[0]).toMatchObject({ discord_user_id: UNBOUND_USER, uid: '', bound: false, quest_type: 'daily_check_in' });
    expect(react).toHaveBeenCalledWith('✅');
    expect(reply).toHaveBeenCalledWith(`<@${UNBOUND_USER}> ${config.replies.unbound}`);
  });

  it('sends one combined reply when several warnings apply', async () => {
    const { handler } = setup();
    const { msg, reply } = message({ authorId: UNBOUND_USER, content: 'hello there' });
    await handler(msg);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(`<@${UNBOUND_USER}> ${config.replies.unmatched}\n${config.replies.unbound}`);
  });

  it('deletes warnings after warning_delete_after_seconds', async () => {
    vi.useFakeTimers();
    const { handler } = setup();
    const { msg, deleteReply } = message({ attachments: [] });
    await handler(msg);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });

  it('deletes outstanding warnings at shutdown instead of leaving them behind', async () => {
    const { handler, reaper } = setup();
    const { msg, deleteReply } = message({ attachments: [] });
    await handler(msg);
    await reaper.removeAllNow();
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });
});

describe('link channel', () => {
  const inLinkChannel = (overrides: Partial<IncomingMessage> = {}) =>
    message({ channelId: LINK_CHANNEL, channelName: 'content', attachments: [], ...overrides });

  it('logs a message with a link as the channel quest type', async () => {
    const { handler, rows } = setup();
    const { msg, react, reply } = inLinkChannel({ content: 'my write-up: <https://example.com/post/42>' });
    await handler(msg);
    expect(rows()).toEqual([
      expect.objectContaining({
        quest_type: 'content_link',
        fuzzy_match: false,
        channel_name: 'content',
        attachment_url: '',
        link_url: 'https://example.com/post/42',
        message_text: 'my write-up: <https://example.com/post/42>',
        bound: true,
        uid: '123456',
      }),
    ]);
    expect(react).toHaveBeenCalledWith('✅');
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores messages without a link: no row, no reaction, no reply', async () => {
    const { handler, recorded } = setup();
    const { msg, react, reply } = inLinkChannel({ content: 'great posts today everyone', attachments: [PNG] });
    await handler(msg);
    expect(recorded).toHaveLength(0);
    expect(react).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('needs no keyword, and leaves attachment_url blank even with an image', async () => {
    const { handler, rows } = setup();
    await handler(inLinkChannel({ content: 'https://example.com/v/abc', attachments: [PNG] }).msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'content_link', attachment_url: '', link_url: 'https://example.com/v/abc' });
  });

  it('reminds an unbound member to /bind, and still logs', async () => {
    const { handler, rows } = setup();
    const { msg, reply } = inLinkChannel({ authorId: UNBOUND_USER, content: 'https://example.com/x' });
    await handler(msg);
    expect(rows()[0]).toMatchObject({ bound: false, uid: '' });
    expect(reply).toHaveBeenCalledWith(`<@${UNBOUND_USER}> ${config.replies.unbound}`);
  });
});

describe('threads and forum posts', () => {
  const THREAD = '444444444444444444';

  it('count toward their parent channel, logged under its name', async () => {
    const { handler, rows } = setup();
    const { msg, react } = message({ channelId: THREAD, parentChannelId: IMAGE_CHANNEL, channelName: 'submissions' });
    await handler(msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'daily_check_in', channel_name: 'submissions', message_link: msg.url });
    expect(react).toHaveBeenCalledWith('✅');
  });

  it('follow their parent channel mode (link threads log links)', async () => {
    const { handler, rows } = setup();
    await handler(message({ channelId: THREAD, parentChannelId: LINK_CHANNEL, content: 'https://example.com/t', attachments: [] }).msg);
    expect(rows()[0]).toMatchObject({ quest_type: 'content_link', link_url: 'https://example.com/t' });
  });

  it('are ignored when the parent channel is not watched', async () => {
    const { handler, recorded } = setup();
    await handler(message({ channelId: THREAD, parentChannelId: OTHER_CHANNEL }).msg);
    expect(recorded).toHaveLength(0);
  });
});

describe('what the bot ignores', () => {
  it.each([
    ['bots, webhooks and system messages (including its own)', { automated: true }],
    ['other channels', { channelId: OTHER_CHANNEL }],
    ['other servers', { guildId: '900000000000000009' }],
    ['direct messages', { guildId: null }],
  ])('%s', async (_label, overrides: Partial<IncomingMessage>) => {
    const { handler, recorded } = setup();
    const { msg, react, reply } = message(overrides);
    await handler(msg);
    expect(recorded).toHaveLength(0);
    expect(react).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('a message delivered twice is logged and reacted to once', async () => {
    const { handler, recorded } = setup();
    const { msg, react } = message();
    await handler(msg);
    await handler(msg);
    expect(recorded).toHaveLength(1);
    expect(react).toHaveBeenCalledTimes(1);
  });
});

describe('failure isolation', () => {
  it('does not show success when the row could not be made durable', async () => {
    const { handler } = setup({
      record: () => {
        throw new Error('disk full');
      },
    });
    const { msg, react } = message();
    await expect(handler(msg)).resolves.toBeUndefined();
    expect(react).not.toHaveBeenCalled();
  });

  it('keeps going when reacting fails', async () => {
    const { handler, rows } = setup();
    const { msg, reply } = message({ authorId: UNBOUND_USER, react: () => Promise.reject(new Error('Missing Permissions')) });
    await expect(handler(msg)).resolves.toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('keeps going when replying fails', async () => {
    const { handler, rows } = setup();
    const { msg } = message({ authorId: UNBOUND_USER, reply: () => Promise.reject(new Error('Missing Permissions')) });
    await expect(handler(msg)).resolves.toBeUndefined();
    expect(rows()).toHaveLength(1);
  });
});
