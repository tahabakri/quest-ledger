import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { BindStore } from '../src/binds.js';
import { parseConfig } from '../src/config.js';
import { type BindInteraction, bindCommandData, createBindHandler } from '../src/discord/bind-command.js';
import { silentLogger } from '../src/logger.js';
import type { WalEntry } from '../src/wal.js';

const config = parseConfig(
  {
    origin: 'test',
    text: `
quests: [{ keyword: invite, type: invite }]
bind:
  command_description: Link your account
  id_label: uid
  id_description: Your account ID
  replies: { success: "Linked!", invalid: "Invalid ID.", error: "Try again." }
channels: [{ id: "111111111111111111", mode: image }]
replies: { unmatched: a, no_image: b, unbound: c }
`,
  },
  {},
).bind;

const A = { id: '100000000000000001', username: 'member_a' };
const B = { id: '100000000000000002', username: 'member_b' };

let interactionId = 0;
function interaction(user: { id: string; username: string }, value: string) {
  const reply = vi.fn((_options: { content: string; flags: MessageFlags.Ephemeral }) => Promise.resolve());
  const fake: BindInteraction = {
    id: `9000000000000000${++interactionId}`,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    user,
    options: { getString: (name) => (name === 'uid' ? value : '') },
    replied: false,
    deferred: false,
    reply,
  };
  return { fake, reply };
}

function setup(record: (entry: WalEntry) => boolean = () => true, grantRole?: (userId: string) => Promise<void>) {
  const store = new BindStore();
  const recorded: WalEntry[] = [];
  const handler = createBindHandler({
    config,
    store,
    writer: {
      record: (entry) => {
        const ok = record(entry);
        recorded.push(entry);
        return ok;
      },
    },
    log: silentLogger,
    grantRole,
  });
  return { store, recorded, handler };
}

describe('/bind', () => {
  it('saves a valid ID and confirms ephemerally', async () => {
    const { store, recorded, handler } = setup();
    const { fake, reply } = interaction(A, '766000123');
    await handler(fake);
    expect(reply).toHaveBeenCalledWith({ content: 'Linked!', flags: MessageFlags.Ephemeral });
    expect(recorded).toEqual([
      {
        id: `bind:${fake.id}`,
        kind: 'bind',
        row: {
          timestamp_utc: '2026-01-01T10:00:00Z',
          discord_user_id: A.id,
          discord_username: 'member_a',
          uid: '766000123',
          duplicate_uid: false,
          last_updated_utc: '2026-01-01T10:00:00Z',
        },
      },
    ]);
    expect(store.lookup(A.id)?.uid).toBe('766000123');
  });

  it.each([
    ['letters', '12345a'],
    ['a prefix', 'ID123456'],
    ['too short (5 digits)', '12345'],
    ['too long (16 digits)', '1234567890123456'],
    ['inner spaces', '123 456'],
    ['a sign', '-123456'],
  ])('rejects %s ephemerally and saves nothing', async (_label, value) => {
    const { store, recorded, handler } = setup();
    const { fake, reply } = interaction(A, value);
    await handler(fake);
    expect(reply).toHaveBeenCalledWith({ content: 'Invalid ID.', flags: MessageFlags.Ephemeral });
    expect(recorded).toHaveLength(0);
    expect(store.lookup(A.id)).toBeUndefined();
  });

  it.each([
    ['6 digits', '123456'],
    ['15 digits', '123456789012345'],
    ['surrounding spaces', '  123456  '],
    ['Arabic-Indic digits', '١٢٣٤٥٦'],
  ])('accepts %s', async (_label, value) => {
    const { recorded, handler } = setup();
    const { fake, reply } = interaction(A, value);
    await handler(fake);
    expect(reply).toHaveBeenCalledWith({ content: 'Linked!', flags: MessageFlags.Ephemeral });
    expect(recorded[0]?.row.uid).toMatch(/^\d+$/);
  });

  it('running /bind twice updates the same user rather than adding one', async () => {
    const { store, recorded, handler } = setup();
    await handler(interaction(A, '111111').fake);
    await handler(interaction(A, '222222').fake);
    expect(store.size).toBe(1);
    expect(recorded.map((e) => e.row.discord_user_id)).toEqual([A.id, A.id]);
    expect(store.lookup(A.id)?.uid).toBe('222222');
  });

  it('flags the second of two users binding the same ID, and still saves it', async () => {
    const { recorded, handler } = setup();
    await handler(interaction(A, '555555').fake);
    const second = interaction(B, '555555');
    await handler(second.fake);
    expect(recorded.map((e) => (e.kind === 'bind' ? e.row.duplicate_uid : null))).toEqual([false, true]);
    expect(second.reply).toHaveBeenCalledWith({ content: 'Linked!', flags: MessageFlags.Ephemeral });
  });

  it('reports an error, and leaves the cache untouched, if the bind cannot be made durable', async () => {
    const { store, handler } = setup(() => {
      throw new Error('disk full');
    });
    const { fake, reply } = interaction(A, '123456');
    await handler(fake);
    expect(reply).toHaveBeenCalledWith({ content: 'Try again.', flags: MessageFlags.Ephemeral });
    expect(store.lookup(A.id)).toBeUndefined();
  });

  it('registers one required string option named after id_label', () => {
    const data = bindCommandData(config);
    expect(data.name).toBe('bind');
    expect(data.options).toEqual([expect.objectContaining({ name: 'uid', required: true, max_length: 100 })]);
  });
});

describe('/bind role', () => {
  it('gives the role after a successful bind, once the member has been answered', async () => {
    const order: string[] = [];
    const grant = vi.fn((userId: string) => {
      order.push(`role:${userId}`);
      return Promise.resolve();
    });
    const { handler } = setup(undefined, grant);
    const { fake } = interaction(A, '766000123');
    fake.reply = (options) => {
      order.push(`reply:${options.content}`);
      return Promise.resolve();
    };
    await handler(fake);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reply:Linked!', `role:${A.id}`]);
  });

  it('gives the role again on a re-bind, so a lost role comes back', async () => {
    const grant = vi.fn((_userId: string) => Promise.resolve());
    const { handler } = setup(undefined, grant);
    await handler(interaction(A, '111111').fake);
    await handler(interaction(A, '222222').fake);
    expect(grant.mock.calls.map(([id]) => id)).toEqual([A.id, A.id]);
  });

  it('gives the role even when the bind is flagged as a duplicate ID', async () => {
    const grant = vi.fn((_userId: string) => Promise.resolve());
    const { handler } = setup(undefined, grant);
    await handler(interaction(A, '555555').fake);
    await handler(interaction(B, '555555').fake);
    expect(grant.mock.calls.map(([id]) => id)).toEqual([A.id, B.id]);
  });

  it.each([
    ['an invalid ID', '12ab34'],
    ['an ID that is too short', '12345'],
  ])('does not give the role for %s', async (_label, value) => {
    const grant = vi.fn((_userId: string) => Promise.resolve());
    const { handler } = setup(undefined, grant);
    await handler(interaction(A, value).fake);
    expect(grant).not.toHaveBeenCalled();
  });

  it('does not give the role when the bind could not be saved', async () => {
    const grant = vi.fn((_userId: string) => Promise.resolve());
    const { handler } = setup(() => {
      throw new Error('disk full');
    }, grant);
    await handler(interaction(A, '123456').fake);
    expect(grant).not.toHaveBeenCalled();
  });

  it('keeps the bind and the success reply when the role cannot be given', async () => {
    const failure = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const { store, handler } = setup(undefined, () => Promise.reject(failure));
    const { fake, reply } = interaction(A, '123456');
    await expect(handler(fake)).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledWith({ content: 'Linked!', flags: MessageFlags.Ephemeral });
    expect(store.lookup(A.id)?.uid).toBe('123456');
  });

  it('still tries the role if the reply itself fails, and still reports that failure', async () => {
    const grant = vi.fn((_userId: string) => Promise.resolve());
    const { handler } = setup(undefined, grant);
    const { fake } = interaction(A, '123456');
    fake.reply = () => Promise.reject(new Error('Unknown interaction'));
    await expect(handler(fake)).rejects.toThrow('Unknown interaction');
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('works without a role configured', async () => {
    const { handler } = setup();
    const { fake, reply } = interaction(A, '123456');
    await expect(handler(fake)).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
