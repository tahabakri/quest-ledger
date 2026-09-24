import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { parseServiceAccount, readSheetsEnv } from '../src/env.js';

// Fake PEM, assembled at runtime so secret scanners don't flag the fixture.
const pem = (edge: string) => `-----${edge} ${'PRIVATE'} KEY-----`;
const KEY = `${pem('BEGIN')}\nMIIfake\n${pem('END')}\n`;
const JSON_KEY = JSON.stringify({ type: 'service_account', client_email: 'bot@example.com', private_key: KEY });
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('service account credentials', () => {
  it('accepts the JSON inline', () => {
    expect(parseServiceAccount(JSON_KEY)).toEqual({ client_email: 'bot@example.com', private_key: KEY });
  });

  it('accepts a path to the key file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ql-env-')), 'key.json');
    writeFileSync(path, JSON_KEY);
    expect(parseServiceAccount(path).client_email).toBe('bot@example.com');
  });

  it('repairs keys whose \\n escapes became real line breaks', () => {
    const mangled = JSON_KEY.replace(/\\n/g, '\n');
    expect(parseServiceAccount(mangled).private_key).toBe(KEY);
  });

  it('rejects incomplete keys without echoing the value', () => {
    const secret = JSON.stringify({ client_email: 'bot@example.com', private_key: 'not-a-key-SECRET' });
    let message = '';
    try {
      parseServiceAccount(secret);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/client_email and private_key/);
    expect(message).not.toContain('SECRET');
  });

  it('explains a missing file', () => {
    expect(() => parseServiceAccount('./nope.json')).toThrow(/key JSON or a path to the key file/);
  });
});

describe('readSheetsEnv', () => {
  it('accepts a bare ID or the full sheet URL', () => {
    const base = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON_KEY };
    expect(readSheetsEnv({ ...base, GOOGLE_SHEET_ID: SHEET_ID }).spreadsheetId).toBe(SHEET_ID);
    expect(
      readSheetsEnv({ ...base, GOOGLE_SHEET_ID: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` })
        .spreadsheetId,
    ).toBe(SHEET_ID);
  });

  it('names the missing variable', () => {
    expect(() => readSheetsEnv({ GOOGLE_SHEET_ID: SHEET_ID })).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON is not set/);
  });
});
