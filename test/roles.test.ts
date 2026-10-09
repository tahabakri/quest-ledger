import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/logger.js';
import { type GuildLike, checkBindRole, roleGrantHint } from '../src/discord/roles.js';

function memoryLogger() {
  const lines: { level: string; message: string }[] = [];
  const log: Logger = {
    debug: () => {},
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
    child: () => log,
  };
  return { log, lines };
}

const GUILD = '900000000000000001';
const ROLE = '555555555555555555';

function guild(overrides: {
  role?: { id?: string; name?: string; managed?: boolean; position?: number } | null;
  hasManageRoles?: boolean;
  botTop?: number;
  fetchRoleFails?: boolean;
  fetchMeFails?: boolean;
}): GuildLike {
  const role =
    overrides.role === null ? null : { id: ROLE, name: 'Member', managed: false, position: 7, ...overrides.role };
  return {
    id: GUILD,
    roles: {
      fetch: () => (overrides.fetchRoleFails ? Promise.reject(new Error('Unknown Role')) : Promise.resolve(role)),
    },
    members: {
      fetchMe: () =>
        overrides.fetchMeFails
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({
              permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageRoles && (overrides.hasManageRoles ?? true) },
              roles: { highest: { position: overrides.botTop ?? 29 } },
            }),
    },
  };
}

describe('roleGrantHint', () => {
  it.each([
    [50013, /Manage Roles permission.*above this role/],
    [50001, /Manage Roles permission/],
    [10011, /bind\.role_id is not a role/],
    [10007, /left the server/],
  ])('explains Discord error %i', (code, expected) => {
    expect(roleGrantHint(Object.assign(new Error('x'), { code }))).toMatch(expected);
  });

  it('has nothing to say about other errors', () => {
    expect(roleGrantHint(new Error('network down'))).toBeUndefined();
    expect(roleGrantHint(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeUndefined();
    expect(roleGrantHint(undefined)).toBeUndefined();
  });
});

describe('checkBindRole', () => {
  it('reports success when the bot can give the role', async () => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({}), ROLE, log);
    expect(lines).toEqual([{ level: 'info', message: 'will give the "Member" role when a member binds' }]);
  });

  it('flags a role that does not exist in the server', async () => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({ role: null }), ROLE, log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error' });
    expect(lines[0]?.message).toMatch(/bind\.role_id is not a role in this server/);
  });

  it('treats a failed role lookup like a missing role', async () => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({ fetchRoleFails: true }), ROLE, log);
    expect(lines[0]?.message).toMatch(/not a role in this server/);
  });

  it.each([
    ['@everyone', { id: GUILD }],
    ['a role managed by an integration', { managed: true }],
  ])('flags %s, which a bot can never give', async (_label, role) => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({ role }), ROLE, log);
    expect(lines[0]).toMatchObject({ level: 'error' });
    expect(lines[0]?.message).toMatch(/cannot be given by a bot/);
  });

  it('flags a bot without the Manage Roles permission', async () => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({ hasManageRoles: false }), ROLE, log);
    expect(lines[0]).toMatchObject({ level: 'error' });
    expect(lines[0]?.message).toMatch(/lacks the Manage Roles permission/);
  });

  it('flags a bot whose highest role is not above the role, including a tie', async () => {
    for (const botTop of [3, 7]) {
      const { log, lines } = memoryLogger();
      await checkBindRole(guild({ botTop }), ROLE, log);
      expect(lines[0]).toMatchObject({ level: 'error' });
      expect(lines[0]?.message).toMatch(/highest role must be above "Member"/);
    }
  });

  it('lists every problem at once', async () => {
    const { log, lines } = memoryLogger();
    await checkBindRole(guild({ hasManageRoles: false, botTop: 1 }), ROLE, log);
    expect(lines[0]?.message).toMatch(/lacks the Manage Roles permission; the bot's highest role must be above/);
  });

  it('never throws, and warns, when the check itself fails', async () => {
    const { log, lines } = memoryLogger();
    await expect(checkBindRole(guild({ fetchMeFails: true }), ROLE, log)).resolves.toBeUndefined();
    expect(lines).toEqual([{ level: 'warn', message: 'could not check the bind role' }]);
  });
});
