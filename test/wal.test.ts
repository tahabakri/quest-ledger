import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteAheadLog } from '../src/wal.js';
import { bind, submission } from './fakes.js';

const open: WriteAheadLog[] = [];

function freshLog(): WriteAheadLog {
  const wal = new WriteAheadLog(join(mkdtempSync(join(tmpdir(), 'ql-wal-')), 'data', 'fallback.jsonl'));
  open.push(wal);
  return wal;
}

afterEach(() => {
  for (const wal of open.splice(0)) wal.close();
});

describe('WriteAheadLog', () => {
  it('starts empty and creates its directory', () => {
    const wal = freshLog();
    expect(wal.open()).toMatchObject({ pending: [], binds: [], corruptLines: 0 });
  });

  it('returns only unacknowledged rows, in write order', () => {
    const wal = freshLog();
    wal.open();
    const [a, b, c] = [submission(), bind(), submission()];
    wal.append(a);
    wal.append(b);
    wal.append(c);
    wal.ack([a.id]);

    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending.map((e) => e.id)).toEqual([b.id, c.id]);
    expect(state.knownIds).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('keeps every bind, acknowledged or not, as the offline bind history', () => {
    const wal = freshLog();
    wal.open();
    const first = bind({ uid: '111111' });
    const second = bind({ uid: '222222' });
    wal.append(first);
    wal.append(second);
    wal.ack([first.id]);
    expect(new WriteAheadLog(wal.path).read().binds.map((r) => r.uid)).toEqual(['111111', '222222']);
  });

  it('survives a write torn by a crash, and keeps later writes readable', () => {
    const wal = freshLog();
    wal.open();
    const before = submission();
    wal.append(before);
    wal.close();
    appendFileSync(wal.path, '{"type":"row","id":"sub:torn","kind":"submis'); // crash mid-write

    const reopened = new WriteAheadLog(wal.path);
    open.push(reopened);
    const state = reopened.open();
    expect(state.corruptLines).toBe(1);
    expect(state.pending.map((e) => e.id)).toEqual([before.id]);

    const after = submission();
    reopened.append(after);
    const final = new WriteAheadLog(wal.path).read();
    expect(final.pending.map((e) => e.id)).toEqual([before.id, after.id]);
    expect(final.corruptLines).toBe(1);
  });

  it('treats a repeated row id as one row', () => {
    const wal = freshLog();
    wal.open();
    const entry = submission();
    wal.append(entry);
    wal.append({ ...entry, row: { ...entry.row, message_text: 'second copy' } } as typeof entry);
    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toEqual(entry);
  });

  it('writes one self-describing JSON object per line', () => {
    const wal = freshLog();
    wal.open();
    const entry = submission();
    wal.append(entry);
    wal.ack([entry.id]);
    const lines = readFileSync(wal.path, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'row', id: entry.id, kind: 'submission', row: entry.row });
    expect(lines[1]).toMatchObject({ type: 'ack', ids: [entry.id] });
  });

  it('refuses to append before it is opened', () => {
    expect(() => freshLog().append(submission())).toThrow(/not open/);
  });
});
