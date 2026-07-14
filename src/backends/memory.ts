import type { ClaimMeta, IdempotencyBackend, StoredRecord } from '../store.js';

interface Row {
  readonly key: string;
  readonly toolName: string;
  readonly request: string;
  readonly status: StoredRecord['status'];
  readonly response?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * In-memory backend. The default: needs no database, so the store is fully
 * testable with zero infra. Suitable for a single process (state is lost on
 * restart and not shared across instances - use a persistent backend for that).
 */
export class MemoryBackend implements IdempotencyBackend {
  private rows = new Map<string, Row>();

  check(key: string): Promise<StoredRecord | undefined> {
    const row = this.rows.get(key);
    if (!row || row.expiresAt <= Date.now()) return Promise.resolve(undefined);
    return Promise.resolve({
      key: row.key,
      status: row.status,
      response: row.response,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  }

  claim(key: string, meta: ClaimMeta): Promise<boolean> {
    const existing = this.rows.get(key);
    // A live row means someone already holds the key. An expired row can be reclaimed.
    if (existing && existing.expiresAt > Date.now()) return Promise.resolve(false);
    this.rows.set(key, {
      key,
      toolName: meta.toolName,
      request: meta.request,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: meta.expiresAt,
    });
    return Promise.resolve(true);
  }

  complete(key: string, response: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, status: 'completed', response });
    return Promise.resolve();
  }

  fail(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, status: 'failed', response: undefined });
    return Promise.resolve();
  }

  reset(key: string, meta: ClaimMeta): Promise<void> {
    this.rows.set(key, {
      key,
      toolName: meta.toolName,
      request: meta.request,
      status: 'pending',
      response: undefined,
      createdAt: Date.now(),
      expiresAt: meta.expiresAt,
    });
    return Promise.resolve();
  }

  cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [key, row] of this.rows) {
      if (row.expiresAt < now) this.rows.delete(key);
    }
    return Promise.resolve();
  }

  /** Test/inspection helper: number of stored rows. */
  size(): number {
    return this.rows.size;
  }
}
