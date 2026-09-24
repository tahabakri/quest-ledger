import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteAheadLog } from '../src/wal.js';
import { submission } from './fakes.js';

// A nearly full disk: write(2) stores only part of the buffer, then fails or recovers.
type DiskMode = 'normal' | 'short-then-full' | 'short-then-recovers' | 'full';
const disk = vi.hoisted(() => {
  const state: { mode: DiskMode } = { mode: 'normal' };
  return state;
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeSync: (fd: number, buffer: Buffer, offset = 0, length = buffer.length - offset) => {
      if (disk.mode === 'full') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      if (disk.mode === 'short-then-full' || disk.mode === 'short-then-recovers') {
        disk.mode = disk.mode === 'short-then-full' ? 'full' : 'normal';
        return real.writeSync(fd, buffer, offset, Math.min(10, length));
      }
      return real.writeSync(fd, buffer, offset, length);
    },
  };
});

const logs: WriteAheadLog[] = [];
function freshLog(): WriteAheadLog {
  const wal = new WriteAheadLog(join(mkdtempSync(join(tmpdir(), 'ql-wal-short-')), 'fallback.jsonl'));
  wal.open();
  logs.push(wal);
  return wal;
}

afterEach(() => {
  disk.mode = 'normal';
  for (const wal of logs.splice(0)) wal.close();
});

describe('WriteAheadLog on a nearly full disk', () => {
  it('throws when a row cannot be written completely, so it is never reported as saved', () => {
    const wal = freshLog();
    const [a, b, c] = [submission(), submission(), submission()];
    wal.append(a);
    disk.mode = 'short-then-full';
    expect(() => wal.append(b)).toThrow(/ENOSPC/);

    disk.mode = 'normal';
    wal.append(c); // must start on a fresh line, not glued to b's fragment
    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending.map((e) => e.id)).toEqual([a.id, c.id]);
    expect(state.corruptLines).toBe(1);
  });

  it('finishes a row that the disk accepted in pieces', () => {
    const wal = freshLog();
    const [a, b] = [submission(), submission()];
    disk.mode = 'short-then-recovers';
    wal.append(a);
    wal.append(b);
    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(state.corruptLines).toBe(0);
  });
});
