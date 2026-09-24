import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

interface LockInfo {
  pid: number;
  host: string;
  purpose: string;
  started_at: string;
}

/**
 * Claims the data directory for this process, so the bot and `npm run replay`
 * (or two copies of the bot) never write the same log at once. A lock left by a
 * process that no longer runs is taken over. Returns a release function.
 */
export function acquireDataLock(dataDir: string, purpose: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, '.lock');
  const mine: LockInfo = { pid: process.pid, host: hostname(), purpose, started_at: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(mine), { flag: 'wx' });
      const release = () => {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
          if (current.pid === mine.pid && current.host === mine.host) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const holder = readLock(path);
    if (holder && holder.host === mine.host && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new LockError(
        `${dataDir} is in use by another quest-ledger process (${holder.purpose}, pid ${holder.pid}, ` +
          `since ${holder.started_at}). Stop it first; two writers would duplicate rows.`,
      );
    }
    // Stale (crashed process, or a different container that can no longer write here).
    try {
      unlinkSync(path);
    } catch {
      // raced with another cleanup; the retry decides
    }
  }
  throw new LockError(`could not lock ${dataDir}`);
}

function readLock(path: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
