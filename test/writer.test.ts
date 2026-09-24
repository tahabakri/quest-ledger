import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { BIND_HEADERS, SUBMISSION_HEADERS } from '../src/sheets/schema.js';
import { type WalEntry, WriteAheadLog } from '../src/wal.js';
import { SheetWriter, type WriterOptions } from '../src/writer.js';
import { FakeSheets, bind, submission } from './fakes.js';

const TABS = { submissions: 'Submissions', binds: 'Binds' };
const logs: WriteAheadLog[] = [];

function setup(overrides: Partial<WriterOptions> = {}) {
  const wal = new WriteAheadLog(join(mkdtempSync(join(tmpdir(), 'ql-writer-')), 'fallback.jsonl'));
  wal.open();
  logs.push(wal);
  const sheets = new FakeSheets();
  const sleeps: number[] = [];
  const writer = new SheetWriter({
    gateway: sheets,
    wal,
    tabs: TABS,
    flushIntervalMs: 5_000,
    flushMaxRows: 20,
    log: silentLogger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { wal, sheets, writer, sleeps };
}

/** A second writer over the same log, as after a restart. */
function restart(wal: WriteAheadLog, sheets: FakeSheets) {
  const reopened = new WriteAheadLog(wal.path);
  const state = reopened.open();
  logs.push(reopened);
  const writer = new SheetWriter({ gateway: sheets, wal: reopened, tabs: TABS, flushIntervalMs: 5_000, flushMaxRows: 20, log: silentLogger, sleep: () => Promise.resolve() });
  writer.restore(state);
  return { writer, wal: reopened };
}

function links(sheets: FakeSheets): string[] {
  return sheets.dataRows(TABS.submissions).map((row) => String(row[SUBMISSION_HEADERS.indexOf('message_link')]));
}

afterEach(() => {
  vi.useRealTimers();
  for (const wal of logs.splice(0)) wal.close();
});

describe('SheetWriter: batching', () => {
  it('writes the log before anything else, then batches rows into one append', async () => {
    const { wal, sheets, writer } = setup({ flushMaxRows: 3 });
    const rows = [submission(), submission(), submission()];
    writer.record(rows[0]!);
    writer.record(rows[1]!);
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(2);
    expect(sheets.callsOf('appendRows')).toHaveLength(0);

    writer.record(rows[2]!); // reaches flushMaxRows
    await writer.flush();
    expect(sheets.callsOf('appendRows')).toEqual([{ op: 'appendRows', tab: 'Submissions', rows: 3 }]);
    expect(links(sheets)).toEqual(rows.map((r) => (r.kind === 'submission' ? r.row.message_link : '')));
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(0);
  });

  it('flushes a partial batch on the interval', async () => {
    vi.useFakeTimers();
    const { sheets, writer } = setup();
    writer.start();
    writer.record(submission());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });

  it('keeps all rows through a burst: 30 rows, no drops, no duplicates', async () => {
    const { sheets, writer } = setup();
    const rows = Array.from({ length: 30 }, () => submission());
    for (const row of rows) writer.record(row);
    await writer.flush();
    expect(links(sheets)).toHaveLength(30);
    expect(new Set(links(sheets)).size).toBe(30);
    expect(sheets.callsOf('appendRows').length).toBeLessThanOrEqual(2);
  });

  it('writes flags as booleans and text verbatim', async () => {
    const { sheets, writer } = setup();
    writer.record(submission({ bound: false, fuzzy_match: true, message_text: '=HYPERLINK("http://x")', uid: '000123' }));
    await writer.flush();
    const [row] = sheets.dataRows(TABS.submissions);
    expect(row![SUBMISSION_HEADERS.indexOf('bound')]).toBe(false);
    expect(row![SUBMISSION_HEADERS.indexOf('fuzzy_match')]).toBe(true);
    expect(row![SUBMISSION_HEADERS.indexOf('message_text')]).toBe('=HYPERLINK("http://x")');
    expect(row![SUBMISSION_HEADERS.indexOf('uid')]).toBe('000123');
  });

  it('records a given row id only once (e.g. a message delivered twice)', () => {
    const { wal, writer } = setup();
    const entry = submission();
    expect(writer.record(entry)).toBe(true);
    expect(writer.record(entry)).toBe(false);
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(1);
  });

  it('creates both tabs with the exact headers', async () => {
    const { sheets, writer } = setup();
    writer.record(submission());
    await writer.flush();
    expect(sheets.tabs.get('Submissions')![0]).toEqual([...SUBMISSION_HEADERS]);
    expect(sheets.tabs.get('Binds')![0]).toEqual([...BIND_HEADERS]);
  });
});

describe('SheetWriter: failures', () => {
  it('retries after 1s, 4s and 16s', async () => {
    const { sheets, writer, sleeps } = setup();
    sheets.failNext(3, { op: 'appendRows' });
    writer.record(submission());
    await writer.flush();
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });

  it('does not duplicate rows when a failed append had actually gone through', async () => {
    const { sheets, writer } = setup();
    sheets.failNext(1, { op: 'appendRows', applied: true });
    writer.record(submission());
    writer.record(submission());
    await writer.flush();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(2);
    expect(writer.stats.skippedExisting).toBe(2);
  });

  it('keeps rows in the log while Sheets is down, pauses, and replays them after a restart', async () => {
    const { wal, sheets, writer, sleeps } = setup();
    sheets.failNext(Number.POSITIVE_INFINITY);
    const rows = [submission(), submission(), bind()];
    for (const row of rows) writer.record(row);
    await writer.flush();

    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(writer.pendingCount).toBe(3);
    expect(new WriteAheadLog(wal.path).read().pending.map((e) => e.id)).toEqual(rows.map((r) => r.id));

    // Paused: a flush right after the failure does not touch Sheets.
    const callsBefore = sheets.calls.length;
    await writer.flush();
    expect(sheets.calls.length).toBe(callsBefore);

    sheets.recover();
    const { writer: after, wal: reopened } = restart(wal, sheets);
    expect(after.pendingCount).toBe(3);
    await expect(after.drainAll()).resolves.toBe(true);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(2);
    expect(sheets.dataRows(TABS.binds)).toHaveLength(1);
    expect(new WriteAheadLog(reopened.path).read().pending).toHaveLength(0);
  });

  it('replays without duplicates when it crashed between the sheet write and the ack', async () => {
    const { wal, sheets } = setup();
    // First run: rows reach the sheet but the ack is never recorded.
    const crashy = new SheetWriter({
      gateway: sheets,
      wal: { append: (e: WalEntry) => wal.append(e), ack: () => { throw new Error('killed before ack'); } },
      tabs: TABS,
      flushIntervalMs: 5_000,
      flushMaxRows: 20,
      log: silentLogger,
    });
    const rows = [submission(), submission(), submission()];
    for (const row of rows) crashy.record(row);
    await crashy.flush();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(3);

    const { writer, wal: reopened } = restart(wal, sheets);
    expect(writer.pendingCount).toBe(3);
    await writer.drainAll();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(3);
    expect(writer.stats.skippedExisting).toBe(3);
    expect(new WriteAheadLog(reopened.path).read().pending).toHaveLength(0);
  });

  it('writes the rows a replay finds missing and skips the ones already present', async () => {
    const { wal, sheets, writer } = setup();
    const written = submission();
    writer.record(written);
    await writer.flush();
    // Simulate a lost ack for `written` plus one row that never made it.
    const missing = submission();
    wal.append(missing);
    const log = new WriteAheadLog(wal.path);
    const state = log.read();
    state.pending.unshift(written);

    const replayer = new SheetWriter({ gateway: sheets, wal, tabs: TABS, flushIntervalMs: 5_000, flushMaxRows: 20, log: silentLogger });
    replayer.restore(state);
    await replayer.drainAll();
    expect(links(sheets)).toEqual([written, missing].map((r) => (r.kind === 'submission' ? r.row.message_link : '')));
  });

  it('refuses to write under mismatched headers and keeps the rows', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [['something', 'else']]);
    writer.record(submission());
    await writer.flush();
    expect(sheets.callsOf('appendRows')).toHaveLength(0);
    expect(writer.pendingCount).toBe(1);

    sheets.tabs.set('Submissions', [[...SUBMISSION_HEADERS]]);
    await expect(writer.drainAll()).resolves.toBe(true);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });
});

describe('SheetWriter: binds', () => {
  const USER_A = '100000000000000001';
  const USER_B = '100000000000000002';

  it('re-binding updates the same row and keeps the first-bound timestamp', async () => {
    const { sheets, writer } = setup();
    writer.record(bind({ discord_user_id: USER_A, uid: '111111', timestamp_utc: '2026-01-01T00:00:00Z', last_updated_utc: '2026-01-01T00:00:00Z' }));
    await writer.flush();
    writer.record(bind({ discord_user_id: USER_A, uid: '222222', timestamp_utc: '2026-01-02T00:00:00Z', last_updated_utc: '2026-01-02T00:00:00Z' }));
    await writer.flush();

    expect(sheets.dataRows(TABS.binds)).toEqual([
      ['2026-01-01T00:00:00Z', USER_A, 'member_one', '222222', false, '2026-01-02T00:00:00Z'],
    ]);
  });

  it('adds a row per user and finds existing rows even after the sheet was re-sorted', async () => {
    const { sheets, writer } = setup();
    writer.record(bind({ discord_user_id: USER_A, uid: '111111' }));
    writer.record(bind({ discord_user_id: USER_B, uid: '111111', duplicate_uid: true }));
    await writer.flush();
    const table = sheets.tabs.get(TABS.binds)!;
    table.splice(1, 2, table[2]!, table[1]!); // a reviewer sorts the sheet

    writer.record(bind({ discord_user_id: USER_A, uid: '333333' }));
    await writer.flush();
    const byUser = new Map(sheets.dataRows(TABS.binds).map((r) => [r[1], r]));
    expect(sheets.dataRows(TABS.binds)).toHaveLength(2);
    expect(byUser.get(USER_A)![3]).toBe('333333');
    expect(byUser.get(USER_B)![3]).toBe('111111');
    expect(byUser.get(USER_B)![4]).toBe(true);
  });

  it('collapses several binds from one user in a batch to the latest', async () => {
    const { sheets, writer } = setup();
    writer.record(bind({ uid: '111111' }));
    writer.record(bind({ uid: '222222' }));
    await writer.flush();
    expect(sheets.dataRows(TABS.binds).map((r) => r[3])).toEqual(['222222']);
  });

  it('does not duplicate a bind row when a failed append had gone through', async () => {
    const { sheets, writer } = setup();
    sheets.failNext(1, { op: 'appendRows', applied: true });
    writer.record(bind());
    await writer.flush();
    expect(sheets.dataRows(TABS.binds)).toHaveLength(1);
  });

  it('refreshBinds hands over sheet rows plus binds not yet written', async () => {
    const { writer } = setup();
    writer.record(bind({ discord_user_id: USER_A, uid: '111111' }));
    await writer.flush();
    writer.record(bind({ discord_user_id: USER_B, uid: '222222' })); // queued, not yet flushed
    const apply = vi.fn();
    await writer.refreshBinds(apply);
    const [sheetRows, pending] = apply.mock.calls[0] as [Array<{ uid: string }>, Array<{ uid: string }>];
    expect(sheetRows.map((r) => r.uid)).toEqual(['111111']);
    expect(pending.map((r) => r.uid)).toEqual(['222222']);
  });
});
