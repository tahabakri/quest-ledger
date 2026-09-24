import { type Client, PermissionFlagsBits } from 'discord.js';
import type { ChannelConfig } from '../config.js';
import type { Logger } from '../logger.js';

const NEEDED = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.AddReactions, 'Add Reactions'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
] as const;

/**
 * At startup, says per watched channel whether the bot can see it and has the
 * permissions it needs, so a wrong ID or a missing permission shows up in the
 * logs on day one instead of as silently missing rows. Never throws.
 */
export async function checkWatchedChannels(
  client: Client<true>,
  channels: readonly ChannelConfig[],
  guildId: string,
  log: Logger,
): Promise<void> {
  for (const watched of channels) {
    const channel = await client.channels.fetch(watched.id).catch(() => null);
    if (!channel || channel.isDMBased()) {
      log.error('watched channel not found, or the bot cannot see it', { channel: watched.id });
      continue;
    }
    if (channel.guildId !== guildId) {
      log.error('watched channel is in a different server than GUILD_ID', { channel: watched.id });
      continue;
    }
    const permissions = channel.permissionsFor(client.user);
    const missing = NEEDED.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
    const name = `#${channel.name}`;
    if (missing.length > 0) {
      log.warn(`missing permissions in ${name}: ${missing.join(', ')}`, { channel: watched.id });
    } else {
      log.info(`watching ${name}`, { channel: watched.id, mode: watched.mode });
    }
  }
}
