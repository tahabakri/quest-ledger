export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Logger;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? 'info').trim().toLowerCase();
  if (normalized === 'warning') return 'warn';
  if (normalized in ORDER) return normalized as LogLevel;
  throw new Error(`LOG_LEVEL must be one of debug, info, warn, error (got "${value}")`);
}

/**
 * Plain one-line-per-event logger. Hosts like Railway capture stdout/stderr, and a
 * "where did my submission go?" investigation is mostly grep, so lines stay flat.
 */
export function createLogger(level: LogLevel = 'info', scope?: string): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[lvl] < min) return;
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${prefix}${message}${formatFields(fields, level)}\n`;
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (childScope) => createLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
}

/** A logger that discards everything, for tests and CLI dry runs. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/**
 * Summarise an error without serialising the whole object. HTTP client errors carry
 * their request config, including the OAuth bearer token, so they must never be
 * dumped wholesale into logs.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const withStatus = err as Error & { status?: unknown; code?: unknown };
  const status = [withStatus.status, withStatus.code].find(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  return status === undefined ? `${err.name}: ${err.message}` : `${err.name}: ${err.message} (status ${status})`;
}

function formatFields(fields: LogFields | undefined, level: LogLevel): string {
  if (!fields) return '';
  const parts: string[] = [];
  let stack: string | undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      parts.push(`${key}=${JSON.stringify(describeError(value))}`);
      if (level === 'debug') stack = value.stack;
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  const text = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return stack ? `${text}\n${stack}` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}
