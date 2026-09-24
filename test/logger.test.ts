import { describe, expect, it } from 'vitest';
import { describeError, parseLogLevel } from '../src/logger.js';

describe('parseLogLevel', () => {
  it('accepts upper-case and the "warning" alias', () => {
    expect(parseLogLevel('INFO')).toBe('info');
    expect(parseLogLevel('warning')).toBe('warn');
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('rejects unknown levels', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/LOG_LEVEL/);
  });
});

describe('describeError', () => {
  it('keeps name, message and status but never the request config', () => {
    const err = Object.assign(new Error('Requested entity was not found.'), {
      status: 404,
      config: { headers: { Authorization: 'Bearer secret-token' } },
    });
    const text = describeError(err);
    expect(text).toBe('Error: Requested entity was not found. (status 404)');
    expect(text).not.toContain('secret-token');
  });
});
