import { describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore, PostgresBackend } from '../src/index.js';
import type { SqlExecutor } from '../src/index.js';

interface DbRow {
  key: string;
  tool_name: string;
  request: string;
  status: 'pending' | 'completed' | 'failed';
  response: string | null;
  created_at: number;
  expires_at: number;
}

/**
 * In-memory stand-in for a Postgres driver that honors the semantics the store
 * relies on: `INSERT ... ON CONFLICT (key) DO NOTHING` conflicts on the primary
 * key (regardless of expiry), and `SELECT ... WHERE expires_at > $2` filters
 * expired rows.
 */
class FakeSql implements SqlExecutor {
  private rows = new Map<string, DbRow>();

  query<Row = Record<string, unknown>>(text: string, params: unknown[]): Promise<Row[]> {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('SELECT')) {
      const [key, minExpires] = params as [string, number];
      const row = this.rows.get(key);
      if (row && row.expires_at > minExpires) return Promise.resolve([row] as unknown as Row[]);
      return Promise.resolve([]);
    }

    if (t.startsWith('INSERT')) {
      const [key, toolName, request, createdAt, expiresAt] = params as [
        string,
        string,
        string,
        number,
        number,
      ];
      if (this.rows.has(key)) return Promise.resolve([]); // ON CONFLICT DO NOTHING
      this.rows.set(key, {
        key,
        tool_name: toolName,
        request,
        status: 'pending',
        response: null,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return Promise.resolve([{ key }] as unknown as Row[]);
    }

    if (t.startsWith('UPDATE')) {
      const row = this.rows.get(params[0] as string);
      if (row) {
        if (t.includes("status = 'completed'")) {
          this.rows.set(row.key, { ...row, status: 'completed', response: params[1] as string });
        } else if (t.includes("status = 'failed'")) {
          this.rows.set(row.key, { ...row, status: 'failed', response: null });
        } else {
          const [, toolName, request, createdAt, expiresAt] = params as [
            string,
            string,
            string,
            number,
            number,
          ];
          this.rows.set(row.key, {
            ...row,
            tool_name: toolName,
            request,
            status: 'pending',
            response: null,
            created_at: createdAt,
            expires_at: expiresAt,
          });
        }
      }
      return Promise.resolve([]);
    }

    if (t.startsWith('DELETE')) {
      const [minExpires] = params as [number];
      for (const [key, row] of this.rows) {
        if (row.expires_at < minExpires) this.rows.delete(key);
      }
      return Promise.resolve([]);
    }

    throw new Error(`FakeSql: unhandled query: ${t}`);
  }
}

describe('PostgresBackend (via fake SqlExecutor)', () => {
  const meta = () => ({ toolName: 't', request: '{}', expiresAt: Date.now() + 1000 });

  it('claim conflicts on the primary key: first wins, second is rejected', async () => {
    const backend = new PostgresBackend(new FakeSql());
    expect(await backend.claim('k', meta())).toBe(true);
    expect(await backend.claim('k', meta())).toBe(false);
  });

  it('returns a completed record and filters expired rows on check', async () => {
    const backend = new PostgresBackend(new FakeSql());
    await backend.claim('k', meta());
    await backend.complete('k', JSON.stringify({ ok: true }));

    const record = await backend.check('k');
    expect(record?.status).toBe('completed');
    expect(record?.response).toBe(JSON.stringify({ ok: true }));

    await backend.reset('k', { toolName: 't', request: '{}', expiresAt: Date.now() - 1 });
    expect(await backend.check('k')).toBeUndefined();
  });

  it('marks a failure and clears the response', async () => {
    const backend = new PostgresBackend(new FakeSql());
    await backend.claim('k', meta());
    await backend.fail('k');
    const record = await backend.check('k');
    expect(record?.status).toBe('failed');
    expect(record?.response).toBeUndefined();
  });

  it('drives the store: runs once, replays on the second call', async () => {
    const store = createIdempotencyStore(new PostgresBackend(new FakeSql()));
    const executor = vi.fn(() => Promise.resolve({ charged: true }));
    await store.execute('k', { toolName: 'charge', request: { amount: 1 } }, executor);
    const second = await store.execute('k', { toolName: 'charge', request: { amount: 1 } }, executor);
    expect(second).toEqual({ charged: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('recovers a crashed pending row via reset', async () => {
    const backend = new PostgresBackend(new FakeSql());
    await backend.claim('k', { toolName: 'charge', request: '{}', expiresAt: Date.now() + 100_000 });

    const store = createIdempotencyStore(backend);
    const executor = vi.fn(() => Promise.resolve({ recovered: true }));
    const result = await store.execute('k', { toolName: 'charge', request: {} }, executor);

    expect(result).toEqual({ recovered: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('cleanupExpired deletes expired rows so the key can be reclaimed', async () => {
    const backend = new PostgresBackend(new FakeSql());
    await backend.claim('k', { toolName: 't', request: '{}', expiresAt: Date.now() - 1 });
    await backend.cleanupExpired();
    expect(await backend.claim('k', meta())).toBe(true);
  });
});
