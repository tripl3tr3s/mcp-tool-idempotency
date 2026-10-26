import { describe, expect, it } from 'vitest';

import { MemoryBackend, PostgresBackend } from '../src/index.js';
import type { ClaimMeta, IdempotencyBackend } from '../src/index.js';
import { FakeSql } from './fake-sql.js';

const HOUR = 60 * 60 * 1000;

function meta(owner: string, overrides: Partial<ClaimMeta> = {}): ClaimMeta {
  const now = Date.now();
  return {
    toolName: 'charge',
    request: '{"orderId":"1"}',
    owner,
    leaseExpiresAt: now + 60_000,
    expiresAt: now + HOUR,
    ...overrides,
  };
}

const backends: Array<[string, () => IdempotencyBackend]> = [
  ['MemoryBackend', () => new MemoryBackend()],
  ['PostgresBackend', () => new PostgresBackend(new FakeSql())],
];

describe.each(backends)('IdempotencyBackend contract: %s', (_name, make) => {
  it('claim: first wins, second loses', async () => {
    const b = make();
    expect(await b.claim('k', meta('a'))).toBe(true);
    expect(await b.claim('k', meta('b'))).toBe(false);
  });

  it('check returns owner, lease and request of the holder', async () => {
    const b = make();
    const m = meta('a');
    await b.claim('k', m);
    const record = await b.check('k');
    expect(record).toMatchObject({
      key: 'k',
      status: 'pending',
      owner: 'a',
      leaseExpiresAt: m.leaseExpiresAt,
      request: m.request,
    });
  });

  it('takeOver refuses a pending row with a live lease', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    expect(await b.takeOver('k', meta('b'), Date.now())).toBe(false);
    expect((await b.check('k'))?.owner).toBe('a');
  });

  it('takeOver refuses a completed or uncertain row', async () => {
    const b = make();
    await b.claim('done', meta('a'));
    await b.complete('done', 'a', '1');
    await b.claim('unsure', meta('a'));
    await b.markUncertain('unsure', 'a', Date.now() + HOUR);
    expect(await b.takeOver('done', meta('b'), Date.now())).toBe(false);
    expect(await b.takeOver('unsure', meta('b'), Date.now())).toBe(false);
  });

  it('takeOver replaces a pending row whose lease expired', async () => {
    const b = make();
    await b.claim('k', meta('a', { leaseExpiresAt: Date.now() - 1 }));
    expect(await b.takeOver('k', meta('b'), Date.now())).toBe(true);
    expect((await b.check('k'))?.owner).toBe('b');
  });

  it('takeOver replaces a failed row', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    await b.fail('k', 'a');
    expect(await b.takeOver('k', meta('b'), Date.now())).toBe(true);
  });

  it('takeOver replaces a row whose TTL expired', async () => {
    const b = make();
    await b.claim('k', meta('a', { expiresAt: Date.now() - 1 }));
    expect(await b.takeOver('k', meta('b'), Date.now())).toBe(true);
    expect((await b.check('k'))?.owner).toBe('b');
  });

  it('takeOver returns false when the row does not exist', async () => {
    expect(await make().takeOver('missing', meta('b'), Date.now())).toBe(false);
  });

  it('takeOver is atomic: concurrent contenders, exactly one wins', async () => {
    const b = make();
    await b.claim('k', meta('a', { leaseExpiresAt: Date.now() - 1 }));
    const now = Date.now();
    const wins = await Promise.all([
      b.takeOver('k', meta('b'), now),
      b.takeOver('k', meta('c'), now),
    ]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('complete, fail, markUncertain and renew are owner-gated', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    expect(await b.renew('k', 'intruder', Date.now() + HOUR)).toBe(false);
    expect(await b.complete('k', 'intruder', '1')).toBe(false);
    expect(await b.markUncertain('k', 'intruder', Date.now() + HOUR)).toBe(false);
    await b.fail('k', 'intruder');
    expect((await b.check('k'))?.status).toBe('pending');

    const lease = Date.now() + HOUR;
    expect(await b.renew('k', 'a', lease)).toBe(true);
    expect((await b.check('k'))?.leaseExpiresAt).toBe(lease);
    expect(await b.complete('k', 'a', '"ok"')).toBe(true);
    expect(await b.check('k')).toMatchObject({ status: 'completed', response: '"ok"' });
  });

  it('a completed row cannot be completed again or failed', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    await b.complete('k', 'a', '1');
    expect(await b.complete('k', 'a', '2')).toBe(false);
    await b.fail('k', 'a');
    expect(await b.check('k')).toMatchObject({ status: 'completed', response: '1' });
  });

  it('markUncertain flips a held row to uncertain', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    const keepUntil = Date.now() + 30 * 24 * HOUR;
    expect(await b.markUncertain('k', 'a', keepUntil)).toBe(true);
    expect(await b.check('k')).toMatchObject({ status: 'uncertain', expiresAt: keepUntil });
  });

  it('forget deletes the row so the key can be claimed again', async () => {
    const b = make();
    await b.claim('k', meta('a'));
    await b.markUncertain('k', 'a', Date.now() + HOUR);
    await b.forget('k');
    expect(await b.check('k')).toBeUndefined();
    expect(await b.claim('k', meta('b'))).toBe(true);
  });

  it('check hides expired rows and cleanupExpired removes them', async () => {
    const b = make();
    await b.claim('k', meta('a', { expiresAt: Date.now() - 1 }));
    expect(await b.check('k')).toBeUndefined();
    await b.cleanupExpired();
    expect(await b.claim('k', meta('b'))).toBe(true);
  });
});
