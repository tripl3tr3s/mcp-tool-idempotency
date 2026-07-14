/**
 * Two-layer idempotency store.
 *
 * Layer 1 - in-process in-flight map: dedupes concurrent calls for the same key
 * with zero storage round-trips (single-threaded JS guarantees no race). The
 * second caller awaits the first caller's promise.
 *
 * Layer 2 - persistent backend: an atomic `claim` plus a TTL, so a completed
 * result is replayed across restarts and only one caller ever wins the claim.
 *
 * Failed executions are never cached - retries stay allowed. A crashed `pending`
 * row is reset and re-executed rather than wedging the key forever.
 */

export interface StoredRecord {
  key: string;
  status: 'pending' | 'completed' | 'failed';
  /** JSON of the completed result; present only when `status === 'completed'`. */
  response?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ClaimMeta {
  toolName: string;
  request: string;
  expiresAt: number;
}

/** Persistence contract. Implement for Postgres, Redis, SQLite, or memory. */
export interface IdempotencyBackend {
  check(key: string): Promise<StoredRecord | undefined>;
  /** Atomic. Returns `true` only for the caller that created the row. */
  claim(key: string, meta: ClaimMeta): Promise<boolean>;
  complete(key: string, response: string): Promise<void>;
  fail(key: string): Promise<void>;
  /** Overwrite a stale/crashed row so it can be re-executed. */
  reset(key: string, meta: ClaimMeta): Promise<void>;
  cleanupExpired(): Promise<void>;
}

export interface ExecuteMeta {
  toolName: string;
  request: Record<string, unknown>;
}

export interface IdempotencyStore {
  execute<T>(key: string, meta: ExecuteMeta, executor: () => Promise<T>): Promise<T>;
}

export interface IdempotencyStoreOptions {
  /** How long a stored result stays replayable. Default 24h. */
  ttlMs?: number;
  /** If set, run `backend.cleanupExpired()` on this interval. Off by default. */
  cleanupIntervalMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function isCompleted(record: StoredRecord | undefined): record is StoredRecord & { response: string } {
  return record?.status === 'completed' && record.response !== undefined;
}

export function createIdempotencyStore(
  backend: IdempotencyBackend,
  options: IdempotencyStoreOptions = {}
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const inFlight = new Map<string, Promise<unknown>>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  function scheduleCleanup(): void {
    if (cleanupTimer || !options.cleanupIntervalMs) return;
    cleanupTimer = setInterval(() => {
      void backend.cleanupExpired();
    }, options.cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  async function runOnce<T>(
    key: string,
    meta: ExecuteMeta,
    executor: () => Promise<T>
  ): Promise<T> {
    // Cache hit from a previous completed execution.
    const cached = await backend.check(key);
    if (isCompleted(cached)) return JSON.parse(cached.response) as T;

    const claimMeta: ClaimMeta = {
      toolName: meta.toolName,
      request: JSON.stringify(meta.request),
      expiresAt: Date.now() + ttlMs,
    };

    const claimed = await backend.claim(key, claimMeta);
    if (!claimed) {
      // Someone else holds the key. If they finished, replay their result;
      // otherwise the holder is stale/crashed - take over and re-run.
      const current = await backend.check(key);
      if (isCompleted(current)) return JSON.parse(current.response) as T;
      await backend.reset(key, claimMeta);
    }

    try {
      const result = await executor();
      await backend.complete(key, JSON.stringify(result));
      return result;
    } catch (error) {
      // Failures are NOT cached - the next call is allowed to retry.
      await backend.fail(key);
      throw error;
    }
  }

  function execute<T>(key: string, meta: ExecuteMeta, executor: () => Promise<T>): Promise<T> {
    scheduleCleanup();

    // Layer 1: concurrent same-process dedup. Registered synchronously so a
    // second call in the same tick sees the in-flight promise.
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = runOnce(key, meta, executor).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return { execute };
}
