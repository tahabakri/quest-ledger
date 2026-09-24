import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { loadDotEnv, readRuntimeEnv, readSheetsEnv } from './env.js';
import { LockError, acquireDataLock } from './lock.js';
import { createLogger, describeError } from './logger.js';
import { HeaderMismatchError, createGoogleSheetsGateway } from './sheets/gateway.js';
import { WAL_FILENAME, WriteAheadLog } from './wal.js';
import { SheetWriter } from './writer.js';

async function main(): Promise<void> {
  loadDotEnv();
  const env = readRuntimeEnv();
  const log = createLogger(env.logLevel);
  const config = loadConfig();
  const sheetsEnv = readSheetsEnv();

  acquireDataLock(env.dataDir, 'bot');
  const wal = new WriteAheadLog(join(env.dataDir, WAL_FILENAME));
  const state = wal.open();
  log.info('write-ahead log opened', {
    path: wal.path,
    pending: state.pending.length,
    corruptLines: state.corruptLines,
  });

  const writer = new SheetWriter({
    gateway: createGoogleSheetsGateway(sheetsEnv),
    wal,
    tabs: { submissions: config.sheets.submissionsTab, binds: config.sheets.bindsTab },
    flushIntervalMs: config.sheets.flushIntervalSeconds * 1000,
    flushMaxRows: config.sheets.flushMaxRows,
    log: log.child('sheets'),
  });
  writer.restore(state);

  // One attempt to reach the sheet. Unreachable is fine (rows wait in the log);
  // wrong headers are not, since every write would land in the wrong columns.
  const reachable = await writer.refreshBinds(() => {});
  log.info(reachable ? 'sheet reachable' : 'sheet unreachable; rows will wait in the write-ahead log');
  writer.start();
  if (state.pending.length > 0) void writer.flush();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal, pending: writer.pendingCount });
    void writer.stop().finally(() => {
      wal.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Configuration problems are fatal and should say exactly what to fix.
  if (err instanceof ConfigError || err instanceof LockError || err instanceof HeaderMismatchError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`fatal: ${describeError(err)}\n`);
  }
  process.exit(1);
});
