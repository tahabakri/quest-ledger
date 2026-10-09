import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { keywordProblems } from './matcher.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** quest_type written when an image submission matches no keyword, even loosely. */
export const UNMATCHED_QUEST_TYPE = 'unmatched';

// YAML is parsed with intAsBigInt so unquoted 18-digit Discord IDs keep their precision.
const snowflake = z.preprocess(
  (v) => (typeof v === 'bigint' || typeof v === 'number' ? v.toString() : v),
  z.string().trim().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)'),
);

const int = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'bigint' ? Number(v) : v), z.number().int().min(min).max(max));

const fraction = z.preprocess(
  (v) => (typeof v === 'bigint' ? Number(v) : v),
  z.number().gt(0, 'must be greater than 0').max(1, 'must be at most 1'),
);

// Discord: 1-32 chars, lowercase letters, numbers, - or _.
const commandName = z
  .string()
  .trim()
  .regex(/^[-_\p{L}\p{N}]{1,32}$/u, 'must be 1-32 characters: letters, numbers, - or _')
  .refine((v) => v === v.toLowerCase(), 'must be lowercase');

const description = z.string().trim().min(1).max(100, 'Discord limits descriptions to 100 characters');

const DISCORD_MESSAGE_LIMIT = 2000;
/** "<@" + a 20-digit ID + "> ". */
const MENTION_ALLOWANCE = 24;

const replyText = z.string().trim().min(1).max(1800);

const questType = z
  .string()
  .trim()
  .min(1)
  .refine((v) => v !== UNMATCHED_QUEST_TYPE, `"${UNMATCHED_QUEST_TYPE}" is reserved for captions that match nothing`);

const regexSource = z
  .string()
  .min(1)
  .superRefine((source, ctx) => {
    try {
      new RegExp(source, 'u');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: `is not a valid regular expression: ${(err as Error).message}` });
    }
  });

const QuestSchema = z.strictObject({
  keyword: z.string().trim().min(1),
  type: questType,
  strict: z.boolean().default(false),
  review: z.boolean().default(false),
  reply: replyText.optional(),
});

const ChannelSchema = z.discriminatedUnion('mode', [
  z.strictObject({ id: snowflake, mode: z.literal('image') }),
  z.strictObject({ id: snowflake, mode: z.literal('link'), quest_type: questType, reply: replyText.optional() }),
]);

const RawConfigSchema = z
  .strictObject({
    quests: z.array(QuestSchema).min(1, 'define at least one quest'),
    fuzzy_threshold: fraction.default(0.8),
    bind: z.strictObject({
      command: commandName.default('bind'),
      command_description: description,
      id_label: commandName,
      id_description: description,
      id_pattern: regexSource.default('^\\d{6,15}$'),
      role_id: snowflake.optional(),
      replies: z.strictObject({
        success: replyText,
        invalid: replyText,
        error: replyText.default('Something went wrong saving that. Please try again in a minute.'),
      }),
    }),
    channels: z.array(ChannelSchema).min(1, 'define at least one channel'),
    replies: z.strictObject({
      unmatched: replyText,
      no_image: replyText,
      unbound: replyText,
    }),
    reactions: z
      .strictObject({
        success: z.string().trim().min(1).default('✅'),
        attention: z.string().trim().min(1).default('❓'),
      })
      .prefault({}),
    warning_delete_after_seconds: int(0, 86_400).default(60),
    image_extensions: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(['png', 'jpg', 'jpeg', 'gif', 'webp']),
    sheets: z
      .strictObject({
        binds_tab: z.string().trim().min(1).max(100).default('Binds'),
        submissions_tab: z.string().trim().min(1).max(100).default('Submissions'),
        flush_interval_seconds: int(1, 300).default(5),
        flush_max_rows: int(1, 500).default(20),
        binds_refresh_minutes: int(0, 1440).default(10),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    for (const problem of keywordProblems(cfg.quests)) {
      ctx.addIssue({ code: 'custom', path: ['quests', problem.index, 'keyword'], message: problem.message });
    }
    const seenChannels = new Map<string, number>();
    cfg.channels.forEach((channel, i) => {
      const first = seenChannels.get(channel.id);
      if (first !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['channels', i, 'id'], message: `duplicates channels[${first}]` });
      } else {
        seenChannels.set(channel.id, i);
      }
    });
    if (cfg.sheets.binds_tab === cfg.sheets.submissions_tab) {
      ctx.addIssue({ code: 'custom', path: ['sheets', 'submissions_tab'], message: 'must differ from binds_tab' });
    }
    // A quest type has one reply wording. Several keywords may share a type (aliases), and
    // then at most one of them carries the reply or they must agree.
    const replyByType = new Map<string, string>();
    const checkReply = (type: string, reply: string | undefined, path: (string | number)[]): void => {
      if (reply === undefined) return;
      const existing = replyByType.get(type);
      if (existing !== undefined && existing !== reply) {
        ctx.addIssue({ code: 'custom', path, message: `quest type "${type}" already has a different reply` });
      } else {
        replyByType.set(type, reply);
      }
    };
    cfg.quests.forEach((quest, i) => checkReply(quest.type, quest.reply, ['quests', i, 'reply']));
    cfg.channels.forEach((channel, i) => {
      if (channel.mode === 'link') checkReply(channel.quest_type, channel.reply, ['channels', i, 'reply']);
    });

    // Worst case is one combined reply: "<@member> " + (a warning or a quest reply) + "\n" + unbound.
    const longest =
      MENTION_ALLOWANCE +
      Math.max(cfg.replies.unmatched.length, cfg.replies.no_image.length, ...[...replyByType.values()].map((r) => r.length)) +
      1 +
      cfg.replies.unbound.length;
    if (longest > DISCORD_MESSAGE_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        path: ['replies'],
        message: `combined replies can reach ${longest} characters; Discord allows ${DISCORD_MESSAGE_LIMIT}. Shorten them.`,
      });
    }
  });

type RawConfig = z.output<typeof RawConfigSchema>;

export interface Quest {
  keyword: string;
  type: string;
  /**
   * Whole-word matches only, with no typo tolerance. For short keywords that
   * would otherwise match inside other words ("join" in "joint").
   */
  strict?: boolean;
  /**
   * A close variant rather than the official caption (a quest's name, an "-ing" form).
   * Submissions that match it are logged under the quest with fuzzy_match = TRUE, so
   * they stand out for manual review.
   */
  review?: boolean;
  /** Posted (mentioning the member) when a submission is logged as this quest. */
  reply?: string;
}

export type ChannelConfig =
  | { id: string; mode: 'image' }
  | { id: string; mode: 'link'; questType: string; reply?: string };

export interface AppConfig {
  quests: Quest[];
  fuzzyThreshold: number;
  bind: {
    command: string;
    commandDescription: string;
    idLabel: string;
    idDescription: string;
    idPattern: RegExp;
    /** Role given to a member whenever their /bind succeeds. */
    roleId?: string;
    replies: { success: string; invalid: string; error: string };
  };
  channels: ChannelConfig[];
  replies: { unmatched: string; noImage: string; unbound: string };
  reactions: { success: string; attention: string };
  warningDeleteAfterSeconds: number;
  imageExtensions: string[];
  sheets: {
    bindsTab: string;
    submissionsTab: string;
    flushIntervalSeconds: number;
    flushMaxRows: number;
    bindsRefreshMinutes: number;
  };
}

export interface ConfigSource {
  text: string;
  /** Human-readable origin for error messages: a file path or "CONFIG_YAML". */
  origin: string;
}

/**
 * CONFIG_YAML (the whole file in one env var) wins, for hosts without file mounts;
 * otherwise the file at CONFIG_PATH, defaulting to ./config.yml.
 */
export function readConfigSource(env: NodeJS.ProcessEnv = process.env): ConfigSource {
  const inline = env.CONFIG_YAML;
  if (inline && inline.trim() !== '') return { text: inline, origin: 'CONFIG_YAML' };
  const path = resolve(env.CONFIG_PATH?.trim() || 'config.yml');
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config found: ${path} does not exist and CONFIG_YAML is not set. ` +
        'Copy config.example.yml to config.yml to get started.',
    );
  }
  return { text: readFileSync(path, 'utf8'), origin: path };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseConfig(readConfigSource(env), env);
}

/**
 * Only the sheet tab names, for recovery tools like `npm run replay`: they must
 * work even where unrelated settings (such as channel ID variables) are absent.
 */
export function readSheetTabs(env: NodeJS.ProcessEnv = process.env): { submissions: string; binds: string } {
  const source = readConfigSource(env);
  let doc: unknown;
  try {
    doc = parseYaml(source.text, { intAsBigInt: true });
  } catch (err) {
    throw new ConfigError(`${source.origin}: invalid YAML: ${(err as Error).message}`);
  }
  const sheets = (doc as { sheets?: unknown } | null)?.sheets ?? {};
  const result = z
    .looseObject({
      binds_tab: z.string().trim().min(1).default('Binds'),
      submissions_tab: z.string().trim().min(1).default('Submissions'),
    })
    .safeParse(interpolateEnv(sheets, env, new Set()));
  if (!result.success) throw new ConfigError(`${source.origin}: invalid sheets settings`);
  return { submissions: result.data.submissions_tab, binds: result.data.binds_tab };
}

export function parseConfig(source: ConfigSource, env: NodeJS.ProcessEnv = process.env): AppConfig {
  let doc: unknown;
  try {
    doc = parseYaml(source.text, { intAsBigInt: true });
  } catch (err) {
    throw new ConfigError(`${source.origin}: invalid YAML: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${source.origin}: expected a YAML mapping at the top level`);
  }

  const missing = new Set<string>();
  const interpolated = interpolateEnv(doc, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      `${source.origin}: references environment variable(s) that are not set: ${[...missing].join(', ')}`,
    );
  }

  const result = RawConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) =>
        `  - ${formatPath(issue.path)}: ${issue.message.replace(/^Invalid input: expected (\w+), received undefined$/, 'is required ($1)')}`,
    );
    throw new ConfigError(`${source.origin}: invalid config\n${lines.join('\n')}`);
  }
  return toAppConfig(result.data);
}

/** Replaces ${VAR} in every string value with process env values. */
function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined || replacement.trim() === '') {
        missing.add(name);
        return '';
      }
      return replacement.trim();
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env, missing));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env, missing)]),
    );
  }
  return value;
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`))
    .join('');
}

function toAppConfig(raw: RawConfig): AppConfig {
  return {
    quests: raw.quests.map((q) => ({
      keyword: q.keyword,
      type: q.type,
      strict: q.strict,
      review: q.review,
      reply: q.reply,
    })),
    fuzzyThreshold: raw.fuzzy_threshold,
    bind: {
      command: raw.bind.command,
      commandDescription: raw.bind.command_description,
      idLabel: raw.bind.id_label,
      idDescription: raw.bind.id_description,
      idPattern: new RegExp(raw.bind.id_pattern, 'u'),
      roleId: raw.bind.role_id,
      replies: raw.bind.replies,
    },
    channels: raw.channels.map((c) =>
      c.mode === 'link'
        ? { id: c.id, mode: 'link', questType: c.quest_type, reply: c.reply }
        : { id: c.id, mode: 'image' },
    ),
    replies: { unmatched: raw.replies.unmatched, noImage: raw.replies.no_image, unbound: raw.replies.unbound },
    reactions: raw.reactions,
    warningDeleteAfterSeconds: raw.warning_delete_after_seconds,
    imageExtensions: raw.image_extensions.map((ext) => ext.replace(/^\./, '').toLowerCase()),
    sheets: {
      bindsTab: raw.sheets.binds_tab,
      submissionsTab: raw.sheets.submissions_tab,
      flushIntervalSeconds: raw.sheets.flush_interval_seconds,
      flushMaxRows: raw.sheets.flush_max_rows,
      bindsRefreshMinutes: raw.sheets.binds_refresh_minutes,
    },
  };
}
