import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { BindRow, SubmissionRow } from './sheets/schema.js';

/** File name inside DATA_DIR. */
export const WAL_FILENAME = 'fallback.jsonl';

export type WalEntry =
  | { id: string; kind: 'submission'; row: SubmissionRow }
  | { id: string; kind: 'bind'; row: BindRow };

type WalLine =
  | ({ type: 'row'; written_at: string } & WalEntry)
  | { type: 'ack'; written_at: string; ids: string[] };

export interface WalState {
  /** Rows never acknowledged by Sheets, in the order they were written. */
  pending: WalEntry[];
  /** Every bind row ever logged, acked or not: the offline fallback for the bind cache. */
  binds: BindRow[];
  /** Every row id in the log, so a message is never logged twice. */
  knownIds: Set<string>;
  /** Lines that could not be parsed (e.g. a write torn by a crash). */
  corruptLines: number;
}

/**
 * Append-only JSONL log (data/fallback.jsonl). Every row is written and fsynced
 * here before any Sheets call; a later `ack` line marks rows as safely in the
 * sheet. Nothing is ever rewritten in place, so a crash can at worst leave one
 * torn final line, which is skipped on the next start.
 */
export class WriteAheadLog {
  private fd: number | undefined;
  /** Set when a partial line may be on disk (crash or failed write): the next entry starts a fresh line. */
  private needsNewline = false;

  constructor(readonly path: string) {}

  /** Reads the log without opening it for writing. */
  read(): WalState {
    const state: WalState = { pending: [], binds: [], knownIds: new Set(), corruptLines: 0 };
    if (!existsSync(this.path)) return state;

    const rows = new Map<string, WalEntry>();
    const acked = new Set<string>();
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const parsed = parseLine(line);
      if (!parsed) {
        state.corruptLines++;
        continue;
      }
      if (parsed.type === 'ack') {
        for (const id of parsed.ids) acked.add(id);
        continue;
      }
      // First occurrence of an id wins; a repeated id is the same row logged twice.
      if (rows.has(parsed.id)) continue;
      const entry = { id: parsed.id, kind: parsed.kind, row: parsed.row } as WalEntry;
      rows.set(entry.id, entry);
      if (entry.kind === 'bind') state.binds.push(entry.row);
    }
    for (const [id, entry] of rows) {
      state.knownIds.add(id);
      if (!acked.has(id)) state.pending.push(entry);
    }
    return state;
  }

  /** Opens for appending and returns the current state. */
  open(): WalState {
    mkdirSync(dirname(this.path), { recursive: true });
    const state = this.read();
    this.fd = openSync(this.path, 'a+');
    // If the last write was torn mid-line, start a fresh line so the next entry stays parseable.
    const size = fstatSync(this.fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(this.fd, last, 0, 1, size - 1);
      this.needsNewline = last[0] !== 0x0a;
    }
    return state;
  }

  append(entry: WalEntry): void {
    this.writeLine(JSON.stringify({ type: 'row', written_at: new Date().toISOString(), ...entry }));
  }

  ack(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.writeLine(JSON.stringify({ type: 'ack', written_at: new Date().toISOString(), ids }));
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  /**
   * Writes one whole line and fsyncs it, or throws. write(2) may store only part
   * of a buffer (e.g. on a nearly full disk), so keep writing until done; if that
   * fails midway, the fragment is left behind as a corrupt line and the next
   * entry is started on a fresh one.
   */
  private writeLine(json: string): void {
    if (this.fd === undefined) throw new Error(`write-ahead log ${this.path} is not open`);
    const data = Buffer.from(`${this.needsNewline ? '\n' : ''}${json}\n`, 'utf8');
    let offset = 0;
    try {
      while (offset < data.length) {
        const written = writeSync(this.fd, data, offset, data.length - offset);
        if (written <= 0) throw new Error(`could not write to ${this.path} (disk full?)`);
        offset += written;
      }
      fsyncSync(this.fd);
      this.needsNewline = false;
    } catch (err) {
      if (offset > 0) this.needsNewline = true;
      throw err;
    }
  }
}

function parseLine(line: string): WalLine | undefined {
  try {
    const value = JSON.parse(line) as Partial<WalLine> | null;
    if (value?.type === 'ack' && Array.isArray(value.ids)) return value as WalLine;
    if (
      value?.type === 'row' &&
      typeof value.id === 'string' &&
      (value.kind === 'submission' || value.kind === 'bind') &&
      typeof value.row === 'object' &&
      value.row !== null
    ) {
      return value as WalLine;
    }
  } catch {
    // fall through: corrupt line
  }
  return undefined;
}
