import { join } from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { BindStore } from './binds.js';
import { ConfigError, loadConfig } from './config.js';
import { bindCommandData, createBindHandler, ephemeral } from './discord/bind-command.js';
import { loadDotEnv, readDiscordEnv, readRuntimeEnv, readSheetsEnv } from './env.js';
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
  const discordEnv = readDiscordEnv();

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

  // Binds: start from the log's history, then prefer the sheet when reachable.
  // Unreachable is fine (rows wait in the log); wrong headers are fatal.
  const binds = new BindStore();
  binds.loadHistory(state.binds);
  const refreshBinds = () => writer.refreshBinds((rows, pending) => binds.replace(rows, pending));
  const reachable = await refreshBinds();
  log.info(reachable ? 'sheet reachable' : 'sheet unreachable; rows will wait in the write-ahead log', {
    binds: binds.size,
  });
  writer.start();
  if (state.pending.length > 0) void writer.flush();
  if (config.sheets.bindsRefreshMinutes > 0) {
    setInterval(() => {
      refreshBinds().catch((err: unknown) => log.error('binds refresh failed', { err }));
    }, config.sheets.bindsRefreshMinutes * 60_000).unref();
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Bot messages never ping @everyone, roles or users unless a reply opts in.
    allowedMentions: { parse: [] },
  });
  const handleBind = createBindHandler({ config: config.bind, store: binds, writer, log: log.child('bind') });

  client.once(Events.ClientReady, (ready) => {
    log.info('connected to Discord', { as: ready.user.tag });
    ready.application.commands.set([bindCommandData(config.bind)], discordEnv.guildId).then(
      () => log.info(`registered /${config.bind.command}`, { guild: discordEnv.guildId }),
      (err: unknown) =>
        log.error(
          `could not register /${config.bind.command}; is the bot in server ${discordEnv.guildId}, ` +
            'invited with the applications.commands scope?',
          { err },
        ),
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== config.bind.command) return;
    if (interaction.guildId !== discordEnv.guildId) return;
    handleBind(interaction).catch(async (err: unknown) => {
      log.error('bind handler failed', { err });
      await ephemeral(interaction, config.bind.replies.error).catch(() => undefined);
    });
  });

  client.on(Events.Error, (err) => log.error('Discord client error', { err }));
  client.on(Events.ShardDisconnect, (event) => log.warn('disconnected from Discord; reconnecting', { code: event.code }));
  client.on(Events.ShardResume, () => log.info('reconnected to Discord'));
  process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal, pending: writer.pendingCount });
    void client
      .destroy()
      .catch(() => undefined)
      .then(() => writer.stop())
      .finally(() => {
        wal.close();
        process.exit(0);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await client.login(discordEnv.token);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'TokenInvalid') {
      throw new ConfigError('Discord rejected DISCORD_BOT_TOKEN. Reset it in the Developer Portal (Bot tab) and update the variable.');
    }
    throw err;
  }
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
