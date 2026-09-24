import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  batchUpdate: vi.fn(),
  values: { append: vi.fn(), get: vi.fn(), batchGet: vi.fn(), batchUpdate: vi.fn() },
  createClient: vi.fn(),
}));

vi.mock('@googleapis/sheets', () => ({
  auth: { GoogleAuth: class {} },
  sheets: (options: unknown) => {
    api.createClient(options);
    return { spreadsheets: { get: api.get, batchUpdate: api.batchUpdate, values: api.values } };
  },
}));

const { HeaderMismatchError, columnLetter, createGoogleSheetsGateway, quoteTab } = await import('../src/sheets/gateway.js');

const gateway = () =>
  createGoogleSheetsGateway({
    spreadsheetId: 'sheet-id',
    credentials: { client_email: 'bot@example.com', private_key: 'fake-key' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(api.values)) fn.mockResolvedValue({ data: {} });
  api.get.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Submissions' } }, { properties: { title: 'Binds' } }] } });
  api.batchUpdate.mockResolvedValue({ data: {} });
});

describe('Google Sheets gateway', () => {
  it('appends RAW (no formula evaluation) and inserts rows instead of overwriting', async () => {
    await gateway().appendRows("Team's Log", 13, [['=IMPORTXML("http://x")', true]]);
    expect(api.values.append).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: "'Team''s Log'!A:M",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { majorDimension: 'ROWS', values: [['=IMPORTXML("http://x")', true]] },
    });
  });

  it('leaves retries to the writer', () => {
    gateway();
    expect(api.createClient).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', retry: false }));
  });

  it('updates whole rows in place, RAW', async () => {
    await gateway().updateRows('Binds', 6, [{ rowNumber: 7, cells: ['a', false] }]);
    expect(api.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { valueInputOption: 'RAW', data: [{ range: "'Binds'!A7:F7", values: [['a', false]] }] },
    });
  });

  it('pads ragged rows when reading', async () => {
    api.values.get.mockResolvedValue({ data: { values: [['a', 'b'], ['c']] } });
    await expect(gateway().readRows('Binds', 3)).resolves.toEqual([
      ['a', 'b', ''],
      ['c', '', ''],
    ]);
    expect(api.values.get).toHaveBeenCalledWith({ spreadsheetId: 'sheet-id', range: "'Binds'!A2:C" });
  });

  it('creates missing tabs and writes headers into empty ones', async () => {
    api.get.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Submissions' } }] } });
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'b']] }, {}] } });
    await gateway().prepareTabs([
      { name: 'Submissions', headers: ['a', 'b'] },
      { name: 'Binds', headers: ['x', 'y', 'z'] },
    ]);
    expect(api.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { requests: [{ addSheet: { properties: { title: 'Binds' } } }] },
    });
    expect(api.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { valueInputOption: 'RAW', data: [{ range: "'Binds'!A1:C1", values: [['x', 'y', 'z']] }] },
    });
  });

  it('refuses a tab whose headers differ, but tolerates extra columns on the right', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'b', 'notes']] }, { values: [['x', 'wrong']] }] } });
    const prepare = gateway().prepareTabs([
      { name: 'Submissions', headers: ['a', 'b'] },
      { name: 'Binds', headers: ['x', 'y'] },
    ]);
    await expect(prepare).rejects.toBeInstanceOf(HeaderMismatchError);
    await expect(prepare).rejects.toThrow(/"Binds" row 1 is \[x, wrong\], expected \[x, y\]/);
    expect(api.values.batchUpdate).not.toHaveBeenCalled();
  });

  it('builds A1 references', () => {
    expect([0, 12, 25, 26, 27].map(columnLetter)).toEqual(['A', 'M', 'Z', 'AA', 'AB']);
    expect(quoteTab('Quest Log')).toBe("'Quest Log'");
  });
});
