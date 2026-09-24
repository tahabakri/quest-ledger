import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockError, acquireDataLock } from '../src/lock.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ql-lock-'));

describe('acquireDataLock', () => {
  it('claims the directory and releases it', () => {
    const dataDir = dir();
    const release = acquireDataLock(dataDir, 'bot');
    expect(JSON.parse(readFileSync(join(dataDir, '.lock'), 'utf8'))).toMatchObject({ pid: process.pid, purpose: 'bot' });
    release();
    expect(existsSync(join(dataDir, '.lock'))).toBe(false);
  });

  it('refuses while another live process on this host holds it', () => {
    const dataDir = dir();
    // The test runner's parent process is alive and is not us.
    const holder = { pid: process.ppid, host: hostname(), purpose: 'bot', started_at: '2026-01-01T00:00:00Z' };
    writeFileSync(join(dataDir, '.lock'), JSON.stringify(holder));
    expect(() => acquireDataLock(dataDir, 'replay')).toThrow(LockError);
    expect(() => acquireDataLock(dataDir, 'replay')).toThrow(/in use by another quest-ledger process \(bot/);
  });

  it('takes over a lock left by a process that is gone', () => {
    const dataDir = dir();
    const stale = { pid: 2_147_483_000, host: hostname(), purpose: 'bot', started_at: '2026-01-01T00:00:00Z' };
    writeFileSync(join(dataDir, '.lock'), JSON.stringify(stale));
    const release = acquireDataLock(dataDir, 'replay');
    expect(JSON.parse(readFileSync(join(dataDir, '.lock'), 'utf8'))).toMatchObject({ pid: process.pid });
    release();
  });
});
