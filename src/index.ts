import { ConfigError, loadConfig } from './config.js';
import { loadDotEnv, readRuntimeEnv } from './env.js';
import { createLogger } from './logger.js';

function main(): void {
  loadDotEnv();
  const env = readRuntimeEnv();
  const log = createLogger(env.logLevel);
  const config = loadConfig();
  log.info('quest-ledger starting', {
    dataDir: env.dataDir,
    quests: config.quests.length,
    channels: config.channels.length,
  });
}

try {
  main();
} catch (err) {
  // Configuration problems are fatal and should say exactly what to fix.
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
