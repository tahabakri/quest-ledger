import { loadDotEnv, readRuntimeEnv } from './env.js';
import { createLogger } from './logger.js';

function main(): void {
  loadDotEnv();
  const env = readRuntimeEnv();
  const log = createLogger(env.logLevel);
  log.info('quest-ledger starting', { dataDir: env.dataDir });
}

main();
