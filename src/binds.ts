import { type BindRow, isoSeconds } from './sheets/schema.js';

/**
 * In-memory view of the Binds tab, so submissions never read the sheet.
 * Kept current by /bind itself, refreshed from the sheet on startup and every
 * few minutes (to pick up manual edits), with binds not yet written re-applied
 * on top so a refresh never loses one.
 */
export class BindStore {
  private readonly byUser = new Map<string, BindRow>();
  private readonly usersByUid = new Map<string, Set<string>>();

  get size(): number {
    return this.byUser.size;
  }

  lookup(userId: string): BindRow | undefined {
    return this.byUser.get(userId);
  }

  /**
   * The row a /bind would write, without applying it. duplicate_uid is TRUE when
   * the ID is currently bound to a different Discord user; the bind still goes
   * ahead and the flag is left for manual review.
   */
  prepare(userId: string, username: string, uid: string, at: Date): BindRow {
    const now = isoSeconds(at);
    const holders = this.usersByUid.get(uid);
    return {
      timestamp_utc: this.byUser.get(userId)?.timestamp_utc || now,
      discord_user_id: userId,
      discord_username: username,
      uid,
      duplicate_uid: holders !== undefined && [...holders].some((holder) => holder !== userId),
      last_updated_utc: now,
    };
  }

  apply(row: BindRow): void {
    const previous = this.byUser.get(row.discord_user_id);
    if (previous) {
      const holders = this.usersByUid.get(previous.uid);
      holders?.delete(row.discord_user_id);
      if (holders?.size === 0) this.usersByUid.delete(previous.uid);
    }
    this.byUser.set(row.discord_user_id, row);
    let holders = this.usersByUid.get(row.uid);
    if (!holders) {
      holders = new Set();
      this.usersByUid.set(row.uid, holders);
    }
    holders.add(row.discord_user_id);
  }

  /**
   * Replaces the cache with the sheet's rows, then re-applies `pending` binds.
   * If a user somehow has several rows, the first is the one kept up to date.
   */
  replace(sheetRows: readonly BindRow[], pending: readonly BindRow[] = []): void {
    this.byUser.clear();
    this.usersByUid.clear();
    for (const row of sheetRows) {
      if (!this.byUser.has(row.discord_user_id)) this.apply(row);
    }
    for (const row of pending) this.apply(row);
  }

  /** Rebuilds from the write-ahead log's bind history (oldest first), for when the sheet is unreachable. */
  loadHistory(rows: readonly BindRow[]): void {
    this.replace([], rows);
  }
}

/**
 * Canonicalises a typed ID before validation: trims, folds full-width digits
 * (NFKC), and maps Arabic-Indic and Persian digits to ASCII, since members type
 * IDs on whatever keyboard they have.
 */
export function normalizeBindId(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
