import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { type BindStore, normalizeBindId } from '../binds.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { BindRow } from '../sheets/schema.js';
import type { SheetWriter } from '../writer.js';

type BindConfig = AppConfig['bind'];

/** The slice of a chat-input interaction the handler uses (a discord.js ChatInputCommandInteraction fits). */
export interface BindInteraction {
  id: string;
  createdAt: Date;
  user: { id: string; username: string };
  options: { getString(name: string, required: true): string };
  replied: boolean;
  deferred: boolean;
  reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
}

export function bindCommandData(config: BindConfig) {
  return new SlashCommandBuilder()
    .setName(config.command)
    .setDescription(config.commandDescription)
    .addStringOption((option) =>
      option.setName(config.idLabel).setDescription(config.idDescription).setRequired(true).setMaxLength(100),
    )
    .toJSON();
}

interface BindDeps {
  config: BindConfig;
  store: BindStore;
  writer: Pick<SheetWriter, 'record'>;
  log: Logger;
}

/**
 * /bind <id>: validates the ID, then records the bind durably before confirming.
 * Every reply is ephemeral, since IDs are semi-private.
 */
export function createBindHandler({ config, store, writer, log }: BindDeps) {
  return async (interaction: BindInteraction): Promise<void> => {
    const user = interaction.user;
    const id = normalizeBindId(interaction.options.getString(config.idLabel, true));
    if (!config.idPattern.test(id)) {
      log.info('bind rejected: invalid ID', { user: user.id });
      await ephemeral(interaction, config.replies.invalid);
      return;
    }

    let row: BindRow;
    try {
      row = store.prepare(user.id, user.username, id, interaction.createdAt);
      writer.record({ id: `bind:${interaction.id}`, kind: 'bind', row });
      store.apply(row);
    } catch (err) {
      log.error('bind not saved', { user: user.id, err });
      await ephemeral(interaction, config.replies.error);
      return;
    }

    log.info('bind saved', { user: user.id, duplicateUid: row.duplicate_uid });
    await ephemeral(interaction, config.replies.success);
  };
}

export async function ephemeral(interaction: BindInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) return;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
