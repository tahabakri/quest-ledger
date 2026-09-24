import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type LogLevel, parseLogLevel } from './logger.js';

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
