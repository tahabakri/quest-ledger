/**
 * Sheet layout. Row 1 of each tab holds exactly these headers, and rows are
 * written in this column order. Row objects use the header names as keys, so the
 * write-ahead log (data/fallback.jsonl) reads like the sheet itself.
 */
export const SUBMISSION_HEADERS = [
  'timestamp_utc',
  'discord_user_id',
  'discord_username',
  'uid',
  'bound',
  'quest_type',
  'fuzzy_match',
  'channel_name',
  'message_text',
  'attachment_url',
  'link_url',
  'message_link',
  'date_utc',
] as const;

export const BIND_HEADERS = [
  'timestamp_utc',
  'discord_user_id',
  'discord_username',
  'uid',
  'duplicate_uid',
  'last_updated_utc',
] as const;

export interface SubmissionRow {
  timestamp_utc: string;
  discord_user_id: string;
  discord_username: string;
  uid: string;
  bound: boolean;
  quest_type: string;
  fuzzy_match: boolean;
  channel_name: string;
  message_text: string;
  attachment_url: string;
  link_url: string;
  message_link: string;
  date_utc: string;
}

export interface BindRow {
  /** When this Discord user first bound. Preserved when they re-bind. */
  timestamp_utc: string;
  discord_user_id: string;
  discord_username: string;
  uid: string;
  duplicate_uid: boolean;
  last_updated_utc: string;
}

/** Cells are written RAW: strings stay text (no formula injection), booleans become TRUE/FALSE. */
export type Cell = string | boolean;

/** Column index (0-based) that uniquely identifies a submission, used to skip rows already written. */
export const MESSAGE_LINK_COLUMN = SUBMISSION_HEADERS.indexOf('message_link');

export function submissionCells(row: SubmissionRow): Cell[] {
  return SUBMISSION_HEADERS.map((header) => row[header]);
}

export function bindCells(row: BindRow): Cell[] {
  return BIND_HEADERS.map((header) => row[header]);
}

/** Parses a Binds data row read back from the sheet. Returns undefined for blank or malformed rows. */
export function parseBindRow(cells: readonly string[]): BindRow | undefined {
  const [timestamp = '', userId = '', username = '', uid = '', duplicate = '', lastUpdated = ''] = cells.map((c) =>
    c.trim(),
  );
  if (!/^\d{17,20}$/.test(userId) || uid === '') return undefined;
  return {
    timestamp_utc: timestamp,
    discord_user_id: userId,
    discord_username: username,
    uid,
    duplicate_uid: duplicate.toUpperCase() === 'TRUE',
    last_updated_utc: lastUpdated,
  };
}

/** ISO 8601 UTC to the second, e.g. 2026-10-06T14:22:31Z. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
