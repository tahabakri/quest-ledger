/**
 * npm run replay [-- --dry-run] [-- --file path/to/fallback.jsonl]
 *
 * Pushes every row the write-ahead log has not seen acknowledged into the sheet,
 * skipping rows that are already there. The bot does this by itself on startup;
 * this is for manual recovery, e.g. replaying a copied log from another machine.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, readSheetTabs } from './config.js';
import { loadDotEnv, readRuntimeEnv, readSheetsEnv } from './env.js';
import { LockError, acquireDataLock } from './lock.js';
import { createLogger } from './logger.js';
import { createGoogleSheetsGateway } from './sheets/gateway.js';
import { WAL_FILENAME, WriteAheadLog } from './wal.js';
import { SheetWriter } from './writer.js';

const USAGE = `Usage: npm run replay -- [--dry-run] [--file <path>]

  --dry-run    list the rows that would be written, write nothing
  --file       replay this log instead of <DATA_DIR>/${WAL_FILENAME}

Stop the bot first: it replays on startup, and two writers would duplicate rows.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      file: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  loadDotEnv();
  const runtime = readRuntimeEnv();
  const log = createLogger(runtime.logLevel, 'replay');
  const walPath = values.file ? resolve(values.file) : join(runtime.dataDir, WAL_FILENAME);
  if (!existsSync(walPath)) {
    log.info('nothing to replay: no write-ahead log found', { path: walPath });
    return 0;
  }

  const dryRun = values['dry-run'];
  const release = dryRun ? () => {} : acquireDataLock(dirname(walPath), 'replay');
  const wal = new WriteAheadLog(walPath);
  try {
    const state = dryRun ? wal.read() : wal.open();
    const submissions = state.pending.filter((e) => e.kind === 'submission').length;
    log.info('write-ahead log read', {
      path: walPath,
      pendingSubmissions: submissions,
      pendingBinds: state.pending.length - submissions,
      corruptLines: state.corruptLines,
    });
    if (state.pending.length === 0) {
      log.info('nothing to replay: every row is already acknowledged');
      return 0;
    }
    if (dryRun) {
      for (const entry of state.pending) {
        const detail = entry.kind === 'submission' ? entry.row.quest_type : `uid ${entry.row.uid}`;
        process.stdout.write(`${entry.row.timestamp_utc}  ${entry.kind.padEnd(10)}  ${entry.id}  ${detail}\n`);
      }
      return 0;
    }

    const writer = new SheetWriter({
      gateway: createGoogleSheetsGateway(readSheetsEnv()),
      wal,
      tabs: readSheetTabs(),
      flushIntervalMs: 5_000,
      flushMaxRows: Number.MAX_SAFE_INTEGER,
      log,
    });
    writer.restore(state);
    const complete = await writer.drainAll();
    log.info(complete ? 'replay complete' : 'replay incomplete; run it again once Sheets is reachable', {
      written: writer.stats.appended + writer.stats.updated,
      alreadyInSheet: writer.stats.skippedExisting,
      remaining: writer.pendingCount,
    });
    return complete ? 0 : 1;
  } finally {
    wal.close();
    release();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError || err instanceof LockError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exit(1);
  },
);
