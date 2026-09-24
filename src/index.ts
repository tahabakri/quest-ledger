import { join } from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { BindStore, keepBindsFresh } from './binds.js';
import { ConfigError, loadConfig } from './config.js';
import { bindCommandData, createBindHandler, ephemeral } from './discord/bind-command.js';
import { checkWatchedChannels } from './discord/channel-check.js';
import { WarningReaper, createMessageHandler, fromDiscordMessage } from './discord/message-handler.js';
import { loadDotEnv, readDiscordEnv, readRuntimeEnv, readSheetsEnv } from './env.js';
import { LockError, acquireDataLock } from './lock.js';
import { createLogger, describeError } from './logger.js';
import { QuestMatcher } from './matcher.js';
import { createGoogleSheetsGateway } from './sheets/gateway.js';
import { WAL_FILENAME, WriteAheadLog } from './wal.js';
import { SheetWriter } from './writer.js';

const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: 'Discord rejected DISCORD_BOT_TOKEN. Reset it in the Developer Portal (Bot tab) and update the variable.',
  4014:
    'Discord refused the Message Content intent. Enable it: Developer Portal > your app > Bot > ' +
    'Privileged Gateway Intents > Message Content Intent.',
};

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

  // Binds: start from the log's history, then prefer the sheet when it can be read.
  // A sheet that is unreachable or misconfigured never stops the bot: submissions
  // keep landing in the log, and writes resume once the sheet is fixed.
  const binds = new BindStore();
  binds.loadHistory(state.binds);
  const refreshBinds = () => writer.refreshBinds((rows, pending) => binds.replace(rows, pending));
  const loaded = await refreshBinds();
  log.info(loaded ? 'sheet ready' : 'sheet not usable yet; rows will wait in the write-ahead log', {
    binds: binds.size,
  });
  writer.start();
  if (state.pending.length > 0) void writer.flush();
  keepBindsFresh({
    refresh: refreshBinds,
    loaded,
    intervalMs: config.sheets.bindsRefreshMinutes * 60_000,
    retryMs: 30_000,
    onError: (err) => log.error('binds refresh failed', { err }),
  });

  const client = new Client({
    // Message Content is a privileged intent: enable it in the Developer Portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    // Bot messages never ping @everyone, roles or users unless a reply opts in.
    allowedMentions: { parse: [] },
  });
  const handleBind = createBindHandler({ config: config.bind, store: binds, writer, log: log.child('bind') });
  const reaper = new WarningReaper(config.warningDeleteAfterSeconds * 1000, log);
  const handleMessage = createMessageHandler({
    config,
    guildId: discordEnv.guildId,
    matcher: new QuestMatcher(config.quests, config.fuzzyThreshold),
    binds,
    writer,
    reaper,
    log: log.child('submissions'),
  });

  client.once(Events.ClientReady, (ready) => {
    log.info('connected to Discord', { as: ready.user.tag });
    void checkWatchedChannels(ready, config.channels, discordEnv.guildId, log);
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

  // Join new threads (and forum posts) in watched channels so their messages are delivered.
  const watchedIds = new Set(config.channels.map((c) => c.id));
  client.on(Events.ThreadCreate, (thread) => {
    if (thread.parentId === null || !watchedIds.has(thread.parentId) || thread.joined || !thread.joinable) return;
    thread.join().catch((err: unknown) => log.warn('could not join a thread in a watched channel', { thread: thread.id, err }));
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(fromDiscordMessage(message)).catch((err: unknown) =>
      log.error('message handler failed', { message: message.id, err }),
    );
  });

  let stopping = false;
  const shutdown = (reason: string, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { reason, pending: writer.pendingCount });
    void reaper
      .removeAllNow()
      .then(() => client.destroy())
      .catch(() => undefined)
      .then(() => writer.stop())
      .finally(() => {
        wal.close();
        process.exit(exitCode);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));

  client.on(Events.Error, (err) => log.error('Discord client error', { err }));
  client.on(Events.ShardResume, () => log.info('reconnected to Discord'));
  // discord.js reconnects on its own; this fires only when it has given up.
  // Exit so the host restarts the bot instead of leaving it running deaf.
  client.on(Events.ShardDisconnect, (event) => {
    log.error(FATAL_CLOSE_CODES[event.code] ?? 'disconnected from Discord and cannot reconnect', { code: event.code });
    shutdown(`gateway closed (${event.code})`, 1);
  });
  process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));

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
  if (err instanceof ConfigError || err instanceof LockError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`fatal: ${describeError(err)}\n`);
  }
  process.exit(1);
});
