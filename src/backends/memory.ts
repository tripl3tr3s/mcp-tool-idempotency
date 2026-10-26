import type { ClaimMeta, IdempotencyBackend, StoredRecord } from '../store.js';

interface Row {
  readonly key: string;
  readonly toolName: string;
  readonly request: string;
  readonly status: StoredRecord['status'];
  readonly response?: string;
  readonly owner: string;
  readonly leaseExpiresAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

function newRow(key: string, meta: ClaimMeta, now: number): Row {
  return {
    key,
    toolName: meta.toolName,
    request: meta.request,
    status: 'pending',
    owner: meta.owner,
    leaseExpiresAt: meta.leaseExpiresAt,
    createdAt: now,
    expiresAt: meta.expiresAt,
  };
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
      request: row.request,
      owner: row.owner,
      leaseExpiresAt: row.leaseExpiresAt,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  }

  claim(key: string, meta: ClaimMeta): Promise<boolean> {
    const now = Date.now();
    const existing = this.rows.get(key);
    // A live row means someone already holds the key. An expired row can be reclaimed.
    if (existing && existing.expiresAt > now) return Promise.resolve(false);
    this.rows.set(key, newRow(key, meta, now));
    return Promise.resolve(true);
  }

  takeOver(key: string, meta: ClaimMeta, now: number): Promise<boolean> {
    const row = this.rows.get(key);
    const replaceable =
      row !== undefined &&
      (row.expiresAt <= now ||
        row.status === 'failed' ||
        (row.status === 'pending' && row.leaseExpiresAt <= now));
    if (!replaceable) return Promise.resolve(false);
    this.rows.set(key, newRow(key, meta, now));
    return Promise.resolve(true);
  }

  renew(key: string, owner: string, leaseExpiresAt: number): Promise<boolean> {
    return Promise.resolve(this.updateHeld(key, owner, (row) => ({ ...row, leaseExpiresAt })));
  }

  complete(key: string, owner: string, response: string): Promise<boolean> {
    return Promise.resolve(
      this.updateHeld(key, owner, (row) => ({ ...row, status: 'completed', response }))
    );
  }

  fail(key: string, owner: string): Promise<void> {
    this.updateHeld(key, owner, (row) => ({ ...row, status: 'failed', response: undefined }));
    return Promise.resolve();
  }

  markUncertain(key: string, owner: string, expiresAt: number): Promise<boolean> {
    return Promise.resolve(
      this.updateHeld(key, owner, (row) => ({
        ...row,
        status: 'uncertain',
        response: undefined,
        expiresAt,
      }))
    );
  }

  forget(key: string): Promise<void> {
    this.rows.delete(key);
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

  /** Apply `update` only if `owner` holds a `pending` row for `key`. */
  private updateHeld(key: string, owner: string, update: (row: Row) => Row): boolean {
    const row = this.rows.get(key);
    if (!row || row.owner !== owner || row.status !== 'pending') return false;
    this.rows.set(key, update(row));
    return true;
  }
}
