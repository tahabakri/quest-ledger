import { extname } from 'node:path';
import { UNMATCHED_QUEST_TYPE } from './config.js';
import type { QuestMatcher } from './matcher.js';
import { type BindRow, type SubmissionRow, isoSeconds } from './sheets/schema.js';

export type WarningKey = 'unmatched' | 'noImage' | 'unbound';

/** What to do with one message in a watched channel. */
export type Outcome =
  | { action: 'ignore' }
  /** Not logged: the member is told what is missing. */
  | { action: 'warn'; reaction: 'attention'; warnings: WarningKey[] }
  | { action: 'log'; questType: string; fuzzy: boolean; reaction: 'success' | 'attention'; warnings: WarningKey[] };

/**
 * Image channels: a screenshot plus a caption naming the quest.
 *
 * | image | caption            | result                                   |
 * |-------|--------------------|------------------------------------------|
 * | yes   | matches (or typo)  | logged as that quest, success reaction   |
 * | yes   | matches nothing    | logged as "unmatched", attention + warn  |
 * | no    | matches (or typo)  | not logged, attention + warn             |
 * | no    | matches nothing    | ignored (ordinary chat)                  |
 *
 * An unbound member is still logged (bound = FALSE) and reminded to /bind.
 * All warnings for one message go out as one reply.
 */
export function classifyImageMessage(
  input: { text: string; hasImage: boolean; bound: boolean },
  matcher: QuestMatcher,
): Outcome {
  const match = matcher.match(input.text);
  const unbound: WarningKey[] = input.bound ? [] : ['unbound'];
  if (!input.hasImage) {
    return match.kind === 'none' ? { action: 'ignore' } : { action: 'warn', reaction: 'attention', warnings: ['noImage', ...unbound] };
  }
  if (match.kind === 'none') {
    return { action: 'log', questType: UNMATCHED_QUEST_TYPE, fuzzy: false, reaction: 'attention', warnings: ['unmatched', ...unbound] };
  }
  return { action: 'log', questType: match.type, fuzzy: match.kind === 'fuzzy', reaction: 'success', warnings: unbound };
}

/**
 * Link channels: the channel itself names the quest. Any message with an
 * http(s) link is logged as `questType`; anything else is conversation and is
 * ignored without a reaction.
 */
export function classifyLinkMessage(input: { text: string; bound: boolean }, questType: string): Outcome {
  if (extractFirstLink(input.text) === undefined) return { action: 'ignore' };
  return { action: 'log', questType, fuzzy: false, reaction: 'success', warnings: input.bound ? [] : ['unbound'] };
}

export interface AttachmentInfo {
  name: string;
  url: string;
  contentType: string | null;
}

/** By file extension, or by MIME type when the name has none of the accepted extensions. */
export function isImageAttachment(attachment: AttachmentInfo, extensions: readonly string[]): boolean {
  const ext = extname(attachment.name).slice(1).toLowerCase();
  if (ext !== '' && extensions.includes(ext)) return true;
  const mime = attachment.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime.startsWith('image/')) return false;
  const subtype = mime.slice('image/'.length);
  return extensions.includes(subtype) || (subtype === 'jpeg' && extensions.includes('jpg'));
}

const LINK = /https?:\/\/[^\s<>]+/gi;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * First http(s) link in the text, without the punctuation or markdown around it
 * ("<https://...>", "**https://...**", "[label](https://...)", "...https://x.")
 */
export function extractFirstLink(text: string): string | undefined {
  for (const [raw] of text.matchAll(LINK)) {
    let url = raw;
    for (;;) {
      let next = url.replace(/[.,;:!?'"*_~|`]+$/, '');
      const last = next.at(-1);
      const opener = last === undefined ? undefined : CLOSERS[last];
      if (opener !== undefined && count(next, last!) > count(next, opener)) next = next.slice(0, -1);
      if (next === url) break;
      url = next;
    }
    if (URL.canParse(url) && new URL(url).hostname !== '') return url;
  }
  return undefined;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

export interface SubmissionSource {
  createdAt: Date;
  authorId: string;
  authorUsername: string;
  channelName: string;
  content: string;
  url: string;
}

export function buildSubmissionRow(
  source: SubmissionSource,
  details: { questType: string; fuzzy: boolean; attachmentUrl: string; bind: BindRow | undefined },
): SubmissionRow {
  const timestamp = isoSeconds(source.createdAt);
  return {
    timestamp_utc: timestamp,
    discord_user_id: source.authorId,
    discord_username: source.authorUsername,
    uid: details.bind?.uid ?? '',
    bound: details.bind !== undefined,
    quest_type: details.questType,
    fuzzy_match: details.fuzzy,
    channel_name: source.channelName,
    message_text: source.content,
    attachment_url: details.attachmentUrl,
    link_url: extractFirstLink(source.content) ?? '',
    message_link: source.url,
    date_utc: timestamp.slice(0, 10),
  };
}
