import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';

const CHANNEL_A = '111111111111111111';
const CHANNEL_B = '222222222222222222';

const MINIMAL = `
quests:
  - keyword: daily check-in
    type: daily_check_in
bind:
  command_description: Link your account
  id_label: uid
  id_description: Your account ID
  replies:
    success: Linked.
    invalid: Invalid ID.
channels:
  - id: "${CHANNEL_A}"
    mode: image
replies:
  unmatched: No match.
  no_image: Attach a screenshot.
  unbound: Run /bind first.
`;

const parse = (text: string, env: NodeJS.ProcessEnv = {}) => parseConfig({ text, origin: 'test.yml' }, env);

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('config', () => {
  it('parses the committed example config', () => {
    const text = readFileSync(new URL('../config.example.yml', import.meta.url), 'utf8');
    const config = parse(text, { SUBMISSIONS_CHANNEL_ID: CHANNEL_A, LINKS_CHANNEL_ID: CHANNEL_B });

    expect(config.quests.map((q) => q.type)).toEqual(['daily_check_in', 'share_post', 'event_attendance', 'invite']);
    expect(config.fuzzyThreshold).toBe(0.8);
    expect(config.channels).toEqual([
      { id: CHANNEL_A, mode: 'image' },
      { id: CHANNEL_B, mode: 'link', questType: 'content_link' },
    ]);
    expect(config.bind.idPattern.test('123456')).toBe(true);
    expect(config.bind.idPattern.test('12345a')).toBe(false);
    expect(config.reactions).toEqual({ success: '✅', attention: '❓' });
    expect(config.replies.unmatched).toContain('We couldn\'t match this to a quest. We\'ve saved it');
    expect(config.sheets).toEqual({
      bindsTab: 'Binds',
      submissionsTab: 'Submissions',
      flushIntervalSeconds: 5,
      flushMaxRows: 20,
      bindsRefreshMinutes: 10,
    });
  });

  it('applies defaults for every optional setting', () => {
    const config = parse(MINIMAL);
    expect(config.fuzzyThreshold).toBe(0.8);
    expect(config.bind.command).toBe('bind');
    expect(config.bind.idPattern.source).toBe('^\\d{6,15}$');
    expect(config.bind.replies.error).toMatch(/try again/);
    expect(config.reactions).toEqual({ success: '✅', attention: '❓' });
    expect(config.warningDeleteAfterSeconds).toBe(60);
    expect(config.imageExtensions).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    expect(config.sheets.bindsTab).toBe('Binds');
    expect(config.sheets.flushMaxRows).toBe(20);
  });

  it('reads the per-quest strict flag, off by default', () => {
    expect(parse(MINIMAL).quests[0]?.strict).toBe(false);
    const strict = parse(MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    strict: true'));
    expect(strict.quests[0]?.strict).toBe(true);
  });

  it('keeps unquoted 19-digit channel IDs exact (no float rounding)', () => {
    const config = parse(MINIMAL.replace(`"${CHANNEL_A}"`, '1234567890123456789'));
    expect(config.channels[0]?.id).toBe('1234567890123456789');
  });

  it('interpolates ${VAR} and reports every missing variable at once', () => {
    const text = MINIMAL.replace(`"${CHANNEL_A}"`, '"${FIRST}"').replace('Linked.', '"${SECOND}"');
    expect(parse(text, { FIRST: CHANNEL_A, SECOND: 'Done!' }).bind.replies.success).toBe('Done!');
    const message = configError(() => parse(text, { FIRST: '  ' }));
    expect(message).toContain('FIRST');
    expect(message).toContain('SECOND');
  });

  it('prefers CONFIG_YAML over the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ql-config-'));
    const path = join(dir, 'config.yml');
    writeFileSync(path, MINIMAL.replace('daily check-in', 'from file'));
    const env = { CONFIG_PATH: path, CONFIG_YAML: MINIMAL.replace('daily check-in', 'from env') };
    expect(loadConfig(env).quests[0]?.keyword).toBe('from env');
    expect(loadConfig({ CONFIG_PATH: path }).quests[0]?.keyword).toBe('from file');
  });

  it('fails fast with a hint when no config exists', () => {
    const message = configError(() => loadConfig({ CONFIG_PATH: join(tmpdir(), 'does-not-exist.yml') }));
    expect(message).toMatch(/config\.example\.yml/);
  });

  it.each([
    ['an unknown key (typo)', MINIMAL + '\nfuzzy_treshold: 0.7\n', /fuzzy_treshold/],
    ['a threshold above 1', MINIMAL + '\nfuzzy_threshold: 1.5\n', /fuzzy_threshold: must be at most 1/],
    ['a threshold of 0', MINIMAL + '\nfuzzy_threshold: 0\n', /fuzzy_threshold: must be greater than 0/],
    ['an invalid ID regex', MINIMAL.replace('id_description:', "id_pattern: '(['\n  id_description:"), /bind\.id_pattern/],
    ['a malformed channel ID', MINIMAL.replace(`"${CHANNEL_A}"`, '"general"'), /channels\[0\]\.id: must be a Discord ID/],
    [
      'a duplicate keyword (ignoring case and punctuation)',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n  - keyword: "DAILY  check_in!"\n    type: other'),
      /quests\[1\]\.keyword: duplicates quests\[0\]/,
    ],
    [
      'a keyword with no letters or digits',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n  - keyword: "✅"\n    type: other'),
      /quests\[1\]\.keyword: must contain at least one letter or digit/,
    ],
    ['a link channel without quest_type', MINIMAL.replace('mode: image', 'mode: link'), /channels\[0\]\.quest_type/],
    ['the reserved "unmatched" type', MINIMAL.replace('type: daily_check_in', 'type: unmatched'), /reserved/],
    ['an upper-case command name', MINIMAL.replace('id_label: uid', 'id_label: UID'), /bind\.id_label: must be lowercase/],
    [
      'a strict flag that is not true or false',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    strict: maybe'),
      /quests\[0\]\.strict/,
    ],
    ['invalid YAML', 'quests: [unclosed', /invalid YAML/],
    [
      'warnings that combine past Discord\'s 2000-character limit',
      MINIMAL.replace('unmatched: No match.', `unmatched: "${'x'.repeat(1200)}"`).replace(
        'unbound: Run /bind first.',
        `unbound: "${'y'.repeat(900)}"`,
      ),
      /replies: combined warnings can reach 2125 characters/,
    ],
  ])('rejects %s', (_label, text, expected) => {
    expect(configError(() => parse(text))).toMatch(expected);
  });
});
