import { auth, sheets, type sheets_v4 } from '@googleapis/sheets';
import type { Cell } from './schema.js';

export interface TabSpec {
  name: string;
  headers: readonly string[];
}

/** The handful of Sheets operations the bot needs. Faked in tests. */
export interface SheetsGateway {
  /** Creates missing tabs and writes headers into empty ones. Throws HeaderMismatchError if row 1 differs. */
  prepareTabs(tabs: readonly TabSpec[]): Promise<void>;
  /** One read: throws HeaderMismatchError if row 1 differs, or an Error if a tab or its headers are gone. */
  checkHeaders(tabs: readonly TabSpec[]): Promise<void>;
  /** Appends rows after the last row of the tab's table. */
  appendRows(tab: string, width: number, rows: Cell[][]): Promise<void>;
  /** Data rows (row 2 onwards) as displayed strings, padded to `width`. */
  readRows(tab: string, width: number): Promise<string[][]>;
  /** One column (0-based index) from row 2 onwards. */
  readColumn(tab: string, column: number): Promise<string[]>;
  /** Overwrites whole rows in place. `rowNumber` is the 1-based sheet row. */
  updateRows(tab: string, width: number, updates: { rowNumber: number; cells: Cell[] }[]): Promise<void>;
}

/** Row 1 of a tab does not match the expected headers. Writing would scramble columns, so it is never retried blindly. */
export class HeaderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderMismatchError';
  }
}

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export interface GoogleSheetsOptions {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
  timeoutMs?: number;
}

export function createGoogleSheetsGateway(options: GoogleSheetsOptions): SheetsGateway {
  const client = new auth.GoogleAuth({
    credentials: options.credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  // Retries are owned by the writer (1s/4s/16s), so the HTTP client never retries on its own.
  const api: sheets_v4.Sheets = sheets({
    version: 'v4',
    auth: client,
    timeout: options.timeoutMs ?? 20_000,
    retry: false,
  });
  const spreadsheetId = options.spreadsheetId;

  return {
    async prepareTabs(tabs) {
      const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
      const missing = tabs.filter((tab) => !existing.has(tab.name));
      if (missing.length > 0) {
        await api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.name } } })) },
        });
      }

      const { empty: toInitialise } = compareHeaders(tabs, await readHeaderRows(api, spreadsheetId, tabs));
      if (toInitialise.length > 0) {
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: toInitialise.map((tab) => ({
              range: `${quoteTab(tab.name)}!A1:${columnLetter(tab.headers.length - 1)}1`,
              values: [[...tab.headers]],
            })),
          },
        });
      }
    },

    async checkHeaders(tabs) {
      const { empty } = compareHeaders(tabs, await readHeaderRows(api, spreadsheetId, tabs));
      if (empty.length > 0) {
        throw new Error(`row 1 of "${empty.map((t) => t.name).join('", "')}" is empty; headers will be rewritten`);
      }
    },

    async appendRows(tab, width, rows) {
      await api.spreadsheets.values.append({
        spreadsheetId,
        range: `${quoteTab(tab)}!A:${columnLetter(width - 1)}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { majorDimension: 'ROWS', values: rows },
      });
    },

    async readRows(tab, width) {
      const res = await api.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteTab(tab)}!A2:${columnLetter(width - 1)}`,
      });
      return (res.data.values ?? []).map((row) =>
        Array.from({ length: width }, (_, i) => (row[i] === undefined || row[i] === null ? '' : String(row[i]))),
      );
    },

    async readColumn(tab, column) {
      const letter = columnLetter(column);
      const res = await api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(tab)}!${letter}2:${letter}` });
      return (res.data.values ?? []).map((row) => (row[0] === undefined || row[0] === null ? '' : String(row[0])));
    },

    async updateRows(tab, width, updates) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates.map((u) => ({
            range: `${quoteTab(tab)}!A${u.rowNumber}:${columnLetter(width - 1)}${u.rowNumber}`,
            values: [u.cells],
          })),
        },
      });
    },
  };
}

async function readHeaderRows(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  tabs: readonly TabSpec[],
): Promise<string[][]> {
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map((tab) => `${quoteTab(tab.name)}!1:1`),
  });
  return tabs.map((_, i) => (res.data.valueRanges?.[i]?.values?.[0] ?? []).map((cell) => String(cell).trim()));
}

/**
 * Tabs whose row 1 is empty, or throws HeaderMismatchError if any row 1 differs
 * from the expected headers. Extra columns to the right are fine.
 */
function compareHeaders(tabs: readonly TabSpec[], rows: string[][]): { empty: TabSpec[] } {
  const empty: TabSpec[] = [];
  const problems: string[] = [];
  tabs.forEach((tab, i) => {
    const row = rows[i] ?? [];
    if (row.every((cell) => cell === '')) {
      empty.push(tab);
      return;
    }
    const actual = row.slice(0, tab.headers.length);
    if (actual.join('\u0000') !== tab.headers.join('\u0000')) {
      problems.push(`tab "${tab.name}" row 1 is [${actual.join(', ')}], expected [${tab.headers.join(', ')}]`);
    }
  });
  if (problems.length > 0) throw new HeaderMismatchError(`Sheet headers do not match: ${problems.join('; ')}`);
  return { empty };
}

/** A1-notation tab reference; always quoted so names with spaces or quotes work. */
export function quoteTab(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
