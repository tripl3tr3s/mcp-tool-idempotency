import { describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore, PostgresBackend } from '../src/index.js';
import { FakeSql } from './fake-sql.js';

// Behavior shared with MemoryBackend lives in backend-contract.test.ts. These
// cases cover what only the Postgres adapter has: SQL shape and 0.1.0 rows.

describe('PostgresBackend (via fake SqlExecutor)', () => {
  it('drives the store: runs once, replays on the second call', async () => {
    const store = createIdempotencyStore(new PostgresBackend(new FakeSql()));
    const executor = vi.fn(() => Promise.resolve({ charged: true }));
    await store.execute('k', { toolName: 'charge', request: { amount: 1 } }, executor);
    const second = await store.execute(
      'k',
      { toolName: 'charge', request: { amount: 1 } },
      executor
    );
    expect(second).toEqual({ charged: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('recovers a pending row left by 0.1.0 (NULL owner and lease)', async () => {
    const sql = new FakeSql();
    sql.rows.set('k', {
      key: 'k',
      tool_name: 'charge',
      request: '{}',
      status: 'pending',
      response: null,
      owner: null,
      lease_expires_at: null,
      created_at: Date.now(),
      expires_at: Date.now() + 100_000,
    });
    const backend = new PostgresBackend(sql);
    expect((await backend.check('k'))?.leaseExpiresAt).toBeUndefined();

    const executor = vi.fn(() => Promise.resolve({ recovered: true }));
    const result = await createIdempotencyStore(backend).execute(
      'k',
      { toolName: 'charge', request: {} },
      executor
    );
    expect(result).toEqual({ recovered: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('binds every value as a parameter and never selects *', async () => {
    const sql = new FakeSql();
    const backend = new PostgresBackend(sql);
    const evil = "k'; DROP TABLE idempotency_keys; --";
    const meta = {
      toolName: evil,
      request: evil,
      owner: evil,
      leaseExpiresAt: Date.now() + 1000,
      expiresAt: Date.now() + 1000,
    };
    await backend.claim(evil, meta);
    await backend.check(evil);
    await backend.takeOver(evil, meta, Date.now());
    await backend.renew(evil, evil, Date.now());
    await backend.complete(evil, evil, evil);
    await backend.fail(evil, evil);
    await backend.markUncertain(evil, evil, Date.now());
    await backend.forget(evil);
    await backend.cleanupExpired();

    for (const statement of sql.statements) {
      expect(statement).not.toContain('DROP');
      expect(statement).not.toMatch(/SELECT \*/);
    }
  });
});
