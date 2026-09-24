import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './config.js';
import { type LogLevel, parseLogLevel } from './logger.js';
import type { ServiceAccountCredentials } from './sheets/gateway.js';

/**
 * Loads `.env` into process.env for local runs. Real environment variables win,
 * so a host's dashboard settings are never overridden by a stray file.
 */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface RuntimeEnv {
  logLevel: LogLevel;
  /** Directory for the write-ahead log. Must be persistent storage in production. */
  dataDir: string;
}

export function readRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  return {
    logLevel: parseLogLevel(env.LOG_LEVEL),
    dataDir: resolve(env.DATA_DIR?.trim() || 'data'),
  };
}

export interface SheetsEnv {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
}

export function readSheetsEnv(env: NodeJS.ProcessEnv = process.env): SheetsEnv {
  const rawId = required(env, 'GOOGLE_SHEET_ID');
  // Accept the full URL too: .../spreadsheets/d/<id>/edit
  const spreadsheetId = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(rawId)?.[1] ?? rawId;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new ConfigError('GOOGLE_SHEET_ID must be a spreadsheet ID (the part of its URL between /d/ and /edit) or URL');
  }
  return { spreadsheetId, credentials: parseServiceAccount(required(env, 'GOOGLE_SERVICE_ACCOUNT_JSON')) };
}

/**
 * GOOGLE_SERVICE_ACCOUNT_JSON holds either the key file's JSON (one line is
 * safest in env vars) or a path to the key file. Never echoes the value back.
 */
export function parseServiceAccount(raw: string): ServiceAccountCredentials {
  const trimmed = raw.trim();
  let text = trimmed;
  if (!trimmed.startsWith('{')) {
    const path = resolve(trimmed);
    if (!existsSync(path)) {
      throw new ConfigError(
        'GOOGLE_SERVICE_ACCOUNT_JSON must be the service-account key JSON or a path to the key file ' +
          `(no file at ${path})`,
      );
    }
    text = readFileSync(path, 'utf8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      // Some dashboards turn the \n escapes inside private_key into real line breaks.
      parsed = JSON.parse(text.replace(/\r?\n/g, '\\n'));
    } catch {
      throw new ConfigError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }

  const { client_email: email, private_key: key } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw new ConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key (create a JSON key for the service account)',
    );
  }
  return { client_email: email, private_key: key.replace(/\\n/g, '\n') };
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set (see .env.example)`);
  return value;
}
