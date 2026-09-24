import { describe, expect, it } from 'vitest';
import { BindStore, normalizeBindId } from '../src/binds.js';
import type { BindRow } from '../src/sheets/schema.js';

const A = '100000000000000001';
const B = '100000000000000002';
const T1 = new Date('2026-01-01T10:00:00.123Z');
const T2 = new Date('2026-01-02T11:30:00.999Z');

function bindNow(store: BindStore, user: string, uid: string, at = T1): BindRow {
  const row = store.prepare(user, `user_${user.slice(-1)}`, uid, at);
  store.apply(row);
  return row;
}

describe('BindStore', () => {
  it('prepares a row without applying it', () => {
    const store = new BindStore();
    const row = store.prepare(A, 'member_a', '123456', T1);
    expect(row).toEqual({
      timestamp_utc: '2026-01-01T10:00:00Z',
      discord_user_id: A,
      discord_username: 'member_a',
      uid: '123456',
      duplicate_uid: false,
      last_updated_utc: '2026-01-01T10:00:00Z',
    });
    expect(store.lookup(A)).toBeUndefined();
  });

  it('keeps the first-bound time and updates the rest when a user re-binds', () => {
    const store = new BindStore();
    bindNow(store, A, '111111', T1);
    const again = bindNow(store, A, '222222', T2);
    expect(again).toMatchObject({ timestamp_utc: '2026-01-01T10:00:00Z', uid: '222222', last_updated_utc: '2026-01-02T11:30:00Z' });
    expect(store.size).toBe(1);
  });

  it('flags a second user binding an ID someone else holds', () => {
    const store = new BindStore();
    expect(bindNow(store, A, '123456').duplicate_uid).toBe(false);
    expect(bindNow(store, B, '123456').duplicate_uid).toBe(true);
  });

  it('does not flag a user re-binding their own ID', () => {
    const store = new BindStore();
    bindNow(store, A, '123456');
    expect(bindNow(store, A, '123456').duplicate_uid).toBe(false);
  });

  it('stops counting an ID once its holder moves to another', () => {
    const store = new BindStore();
    bindNow(store, A, '123456');
    bindNow(store, A, '654321');
    expect(bindNow(store, B, '123456').duplicate_uid).toBe(false);
  });

  it('replace() takes the sheet as truth, then re-applies binds not yet written', () => {
    const store = new BindStore();
    bindNow(store, A, '999999'); // stale local state
    const sheet: BindRow[] = [store.prepare(A, 'member_a', '111111', T1)];
    const pending: BindRow[] = [store.prepare(B, 'member_b', '111111', T2)];
    store.replace(sheet, pending);
    expect(store.lookup(A)?.uid).toBe('111111');
    expect(store.lookup(B)?.uid).toBe('111111');
    expect(bindNow(store, B, '999999').duplicate_uid).toBe(false); // 999999 no longer held by A
  });

  it('replace() ignores a pending bind that is older than the sheet row', () => {
    const store = new BindStore();
    const sheet = [store.prepare(A, 'member_a', '222222', T2)];
    const stale = store.prepare(A, 'member_a', '111111', T1);
    store.replace(sheet, [stale]);
    expect(store.lookup(A)?.uid).toBe('222222');
  });

  it('replace() keeps a user\'s first sheet row when there are several', () => {
    const store = new BindStore();
    const first = store.prepare(A, 'member_a', '111111', T1);
    const second = store.prepare(A, 'member_a', '222222', T2);
    store.replace([first, second]);
    expect(store.lookup(A)?.uid).toBe('111111');
  });

  it('loadHistory() replays the log oldest-first, so the latest bind wins', () => {
    const store = new BindStore();
    store.loadHistory([store.prepare(A, 'member_a', '111111', T1), store.prepare(A, 'member_a', '222222', T2)]);
    expect(store.lookup(A)?.uid).toBe('222222');
  });
});

describe('normalizeBindId', () => {
  it.each([
    ['  123456  ', '123456'],
    ['１２３４５６', '123456'], // full-width
    ['١٢٣٤٥٦', '123456'], // Arabic-Indic
    ['۱۲۳۴۵۶', '123456'], // Persian
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeBindId(raw)).toBe(expected);
  });
});
