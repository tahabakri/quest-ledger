import { PermissionFlagsBits } from 'discord.js';
import type { Logger } from '../logger.js';

// Discord API error codes that giving a role can run into.
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** A plain-language fix for the Discord errors that giving a role can run into. */
export function roleGrantHint(err: unknown): string | undefined {
  switch (errorCode(err)) {
    case MISSING_PERMISSIONS:
    case MISSING_ACCESS:
      return "the bot needs the Manage Roles permission, and its own highest role must sit above this role in Server Settings > Roles";
    case UNKNOWN_ROLE:
      return 'bind.role_id is not a role in this server';
    case UNKNOWN_MEMBER:
      return 'the member has left the server';
    default:
      return undefined;
  }
}

interface RoleLike {
  id: string;
  name: string;
  managed: boolean;
  position: number;
}

interface BotMemberLike {
  permissions: { has(permission: bigint): boolean };
  roles: { highest: { position: number } };
}

/** The slice of a discord.js Guild that checkBindRole uses. */
export interface GuildLike {
  id: string;
  roles: { fetch(id: string): Promise<RoleLike | null> };
  members: { fetchMe(): Promise<BotMemberLike> };
}

/**
 * At startup, says whether the bot is able to give the bind role, so a missing
 * permission or a role ordered the wrong way shows up in the logs on day one,
 * not as members silently going without the role. Never throws.
 */
export async function checkBindRole(guild: GuildLike, roleId: string, log: Logger): Promise<void> {
  try {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      log.error('bind.role_id is not a role in this server: members will not get a role when they bind', { role: roleId });
      return;
    }
    if (role.id === guild.id || role.managed) {
      log.error(`the "${role.name}" role cannot be given by a bot (it is @everyone or belongs to an integration)`, {
        role: roleId,
      });
      return;
    }
    const me = await guild.members.fetchMe();
    const problems: string[] = [];
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('the bot lacks the Manage Roles permission');
    if (me.roles.highest.position <= role.position) {
      problems.push(`the bot's highest role must be above "${role.name}" in Server Settings > Roles`);
    }
    if (problems.length > 0) {
      log.error(`cannot give the "${role.name}" role when a member binds: ${problems.join('; ')}`, { role: roleId });
    } else {
      log.info(`will give the "${role.name}" role when a member binds`, { role: roleId });
    }
  } catch (err) {
    log.warn('could not check the bind role', { err });
  }
}
