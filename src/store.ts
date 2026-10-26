/**
 * Two-layer idempotency store.
 *
 * Layer 1 - in-process in-flight map: dedupes concurrent calls for the same key
 * with zero storage round-trips (single-threaded JS guarantees no race). The
 * second caller awaits the first caller's promise.
 *
 * Layer 2 - persistent backend: an atomic `claim` with an owner token and a
 * renewing lease. A live holder is never taken over; a holder whose lease
 * expired (crashed) is taken over by a single conditional update. Completed
 * results are replayed for `ttlMs`.
 *
 * The store cannot see inside the executor. A throw or crash after the side
 * effect committed is retried by default; opt into `isRetryable` and
 * `onLeaseExpired: 'uncertain'` to block those retries instead.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyLeaseLostError,
  IdempotencyUncertainError,
} from './errors.js';

export type RecordStatus = 'pending' | 'completed' | 'failed' | 'uncertain';

export interface StoredRecord {
  key: string;
  status: RecordStatus;
  /** JSON of the completed result; present only when `status === 'completed'`. */
  response?: string;
  /** Fingerprint (`sha256:<hex>`) of the request that claimed the key. */
  request?: string;
  /** Token of the execution that holds (or held) the key. */
  owner?: string;
  /** Epoch ms after which a `pending` holder counts as crashed. Missing = legacy row. */
  leaseExpiresAt?: number;
  createdAt: number;
  expiresAt: number;
}

export interface ClaimMeta {
  toolName: string;
  request: string;
  owner: string;
  leaseExpiresAt: number;
  expiresAt: number;
}

/** Persistence contract. Implement for Postgres, Redis, SQLite, or memory. */
export interface IdempotencyBackend {
  /** Returns the record unless it is missing or past `expiresAt`. */
  check(key: string): Promise<StoredRecord | undefined>;
  /** Atomic insert. Returns `true` only for the caller that created the row. */
  claim(key: string, meta: ClaimMeta): Promise<boolean>;
  /**
   * Atomic conditional replace. Succeeds only if the existing row is past its
   * TTL, `failed`, or `pending` with an expired or missing lease. Returns
   * `false` if the row is missing or still held.
   */
  takeOver(key: string, meta: ClaimMeta, now: number): Promise<boolean>;
  /** Extend the lease. Only for the owner of a `pending` row. */
  renew(key: string, owner: string, leaseExpiresAt: number): Promise<boolean>;
  /** Store the result. Only for the owner of a `pending` row. */
  complete(key: string, owner: string, response: string): Promise<boolean>;
  /** Mark retryable failure. Only for the owner of a `pending` row. */
  fail(key: string, owner: string): Promise<void>;
  /** Mark outcome unknown and keep the row until `expiresAt`. Only for the owner of a `pending` row. */
  markUncertain(key: string, owner: string, expiresAt: number): Promise<boolean>;
  /** Delete the row unconditionally (manual reconciliation). */
  forget(key: string): Promise<void>;
  cleanupExpired(): Promise<void>;
}

export interface ExecuteMeta {
  toolName: string;
  request: Record<string, unknown>;
}

export interface ExecutionContext {
  /** The idempotency key. Forward it to the provider's own idempotency header. */
  key: string;
  /** Token of this execution's claim. */
  owner: string;
  /**
   * Aborted if this execution loses the key (a lease renewal found another
   * holder). Check it before committing a side effect, or pass it to `fetch`.
   */
  signal: AbortSignal;
}

export type Executor<T> = (ctx: ExecutionContext) => Promise<T>;

export interface IdempotencyStore {
  execute<T>(key: string, meta: ExecuteMeta, executor: Executor<T>): Promise<T>;
  /** Clear a key (e.g. an uncertain one after reconciling with the provider). */
  forget(key: string): Promise<void>;
}

export interface IdempotencyStoreOptions {
  /** How long a stored result stays replayable. Default 24h. */
  ttlMs?: number;
  /** If set, run `backend.cleanupExpired()` on this interval. Off by default. */
  cleanupIntervalMs?: number;
  /** How long a claim stays live without renewal. Renewed every `leaseMs / 3`. Default 60s. */
  leaseMs?: number;
  /**
   * What to do when taking over a holder whose lease expired (it probably
   * crashed, maybe after its side effect). `'retry'` re-runs (default);
   * `'uncertain'` blocks the key and throws `IdempotencyUncertainError`.
   */
  onLeaseExpired?: 'retry' | 'uncertain';
  /**
   * Classify executor errors. Returning `false` marks the outcome uncertain
   * (the side effect may have happened) and blocks retries. Default: every
   * error is retryable.
   */
  isRetryable?: (error: unknown) => boolean;
  /** How long an uncertain key stays blocked unless `forget` clears it. Default 30 days. */
  uncertainTtlMs?: number;
  /** Throw `IdempotencyConflictError` when a key is reused with a different request. Default true. */
  verifyRequest?: boolean;
  /**
   * When another live execution holds the key, poll for up to this long and
   * replay its result (or take over if it dies) instead of throwing
   * `IdempotencyInFlightError`. Default 0.
   */
  inFlightWaitMs?: number;
  /** Poll interval for `inFlightWaitMs`. Default 100ms, minimum 1ms. */
  inFlightPollMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNCERTAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 100;
/** Lost takeOver races tolerated before giving up with InFlight. */
const MAX_RACES = 3;
/** Attempts to store a result before giving up and marking it uncertain. */
const COMPLETE_ATTEMPTS = 3;
const FINGERPRINT_PREFIX = 'sha256:';

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` serialize the same. */
export function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0
            )
          )
        : v
    ) ?? 'null'
  );
}

/**
 * Request fingerprint stored with each claim. A hash, so request payloads
 * (card data, PII) are never persisted by the store.
 */
export function fingerprintRequest(request: unknown): string {
  return FINGERPRINT_PREFIX + createHash('sha256').update(stableStringify(request)).digest('hex');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Acquired<T> = { readonly replay: true; readonly value: T } | { readonly replay: false };

export function createIdempotencyStore(
  backend: IdempotencyBackend,
  options: IdempotencyStoreOptions = {}
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const uncertainTtlMs = options.uncertainTtlMs ?? DEFAULT_UNCERTAIN_TTL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const verifyRequest = options.verifyRequest ?? true;
  const inFlightWaitMs = options.inFlightWaitMs ?? 0;
  const inFlightPollMs = Math.max(1, options.inFlightPollMs ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS;
  const inFlight = new Map<string, { promise: Promise<unknown>; fingerprint: string }>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  function scheduleCleanup(): void {
    if (cleanupTimer || !options.cleanupIntervalMs) return;
    cleanupTimer = setInterval(() => {
      // Best effort: a failed sweep is retried on the next tick, never crashes the process.
      backend.cleanupExpired().catch(() => undefined);
    }, options.cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  function assertSameRequest(key: string, record: StoredRecord, fingerprint: string): void {
    // Rows written by 0.1.0 hold the raw request, not a fingerprint: skip those.
    if (
      verifyRequest &&
      record.request?.startsWith(FINGERPRINT_PREFIX) &&
      record.request !== fingerprint
    ) {
      throw new IdempotencyConflictError(key);
    }
  }

  function replay<T>(key: string, record: StoredRecord, fingerprint: string): T {
    assertSameRequest(key, record, fingerprint);
    return JSON.parse(record.response ?? 'null') as T;
  }

  function isLiveLease(record: StoredRecord, now: number): boolean {
    return (
      record.status === 'pending' &&
      record.leaseExpiresAt !== undefined &&
      record.leaseExpiresAt > now
    );
  }

  /**
   * Win the key or learn what to replay. Loops only to wait for a live holder
   * (bounded by `inFlightWaitMs`) or after losing a takeover race (bounded by
   * MAX_RACES); a live holder is never touched.
   */
  async function acquire<T>(
    key: string,
    meta: ExecuteMeta,
    owner: string,
    fingerprint: string
  ): Promise<Acquired<T>> {
    const deadline = Date.now() + inFlightWaitMs;
    let races = 0;

    for (;;) {
      const now = Date.now();
      const claimMeta: ClaimMeta = {
        toolName: meta.toolName,
        request: fingerprint,
        owner,
        leaseExpiresAt: now + leaseMs,
        expiresAt: now + ttlMs,
      };
      if (await backend.claim(key, claimMeta)) return { replay: false };

      const current = await backend.check(key);
      if (current?.status === 'completed') {
        return { replay: true, value: replay<T>(key, current, fingerprint) };
      }
      if (current?.status === 'uncertain') {
        assertSameRequest(key, current, fingerprint);
        throw new IdempotencyUncertainError(key);
      }
      if (current && isLiveLease(current, Date.now())) {
        assertSameRequest(key, current, fingerprint);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new IdempotencyInFlightError(key);
        await sleep(Math.min(inFlightPollMs, remaining));
        continue;
      }

      // Failed, expired, or a crashed holder (expired lease): conditional takeover.
      const crashedHolder = current?.status === 'pending';
      if (await backend.takeOver(key, claimMeta, Date.now())) {
        if (crashedHolder && options.onLeaseExpired === 'uncertain') {
          await backend.markUncertain(key, owner, Date.now() + uncertainTtlMs);
          throw new IdempotencyUncertainError(key);
        }
        return { replay: false };
      }

      // Lost a race (another contender took over, or the row vanished): look again.
      races += 1;
      if (races >= MAX_RACES) throw new IdempotencyInFlightError(key);
    }
  }

  /**
   * Run the executor while renewing the lease, so a slow live holder is never
   * taken over. If a renewal finds another holder, abort `ctx.signal`.
   */
  async function withHeartbeat<T>(key: string, owner: string, executor: Executor<T>): Promise<T> {
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        Promise.resolve()
          .then(() => backend.renew(key, owner, Date.now() + leaseMs))
          .then((stillOwner) => {
            if (!stillOwner) controller.abort(new IdempotencyLeaseLostError(key, undefined));
          })
          // A transient renew error is retried on the next tick; the lease covers 3 ticks.
          .catch(() => undefined)
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(1, Math.floor(leaseMs / 3))
    );
    timer.unref?.();
    try {
      return await executor({ key, owner, signal: controller.signal });
    } finally {
      clearInterval(timer);
    }
  }

  /** Store the result, retrying transient errors. `false` = another holder owns the row. */
  async function storeResult(key: string, owner: string, response: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await backend.complete(key, owner, response);
      } catch (error) {
        if (attempt >= COMPLETE_ATTEMPTS) {
          // The side effect happened but cannot be recorded: block re-runs if we can.
          await backend
            .markUncertain(key, owner, Date.now() + uncertainTtlMs)
            .catch(() => undefined);
          throw error;
        }
        await sleep(50 * attempt);
      }
    }
  }

  async function runOnce<T>(
    key: string,
    meta: ExecuteMeta,
    fingerprint: string,
    executor: Executor<T>
  ): Promise<T> {
    // Cache hit from a previous completed execution.
    const cached = await backend.check(key);
    if (cached?.status === 'completed') return replay<T>(key, cached, fingerprint);

    const owner = randomUUID();
    const acquired = await acquire<T>(key, meta, owner, fingerprint);
    if (acquired.replay) return acquired.value;

    let result: T;
    try {
      result = await withHeartbeat(key, owner, executor);
    } catch (error) {
      // Record the failure best effort; the executor's error is what the caller sees.
      try {
        if (options.isRetryable && !options.isRetryable(error)) {
          // The side effect may have committed: block retries until reconciled.
          await backend.markUncertain(key, owner, Date.now() + uncertainTtlMs);
        } else {
          // Failures are NOT cached - the next call is allowed to retry.
          await backend.fail(key, owner);
        }
      } catch {
        // Row stays pending; its lease expires and onLeaseExpired decides.
      }
      throw error;
    }

    // `undefined` has no JSON form; store it as `null` so void executors still replay.
    if (!(await storeResult(key, owner, JSON.stringify(result) ?? 'null'))) {
      throw new IdempotencyLeaseLostError(key, result);
    }
    return result;
  }

  function execute<T>(key: string, meta: ExecuteMeta, executor: Executor<T>): Promise<T> {
    scheduleCleanup();
    let fingerprint: string;
    try {
      fingerprint = fingerprintRequest(meta.request);
    } catch (error) {
      // e.g. BigInt or circular request data: reject, never throw synchronously.
      return Promise.reject(error);
    }

    // Layer 1: concurrent same-process dedup. Registered synchronously so a
    // second call in the same tick sees the in-flight promise.
    const existing = inFlight.get(key);
    if (existing) {
      if (verifyRequest && existing.fingerprint !== fingerprint) {
        return Promise.reject(new IdempotencyConflictError(key));
      }
      return existing.promise as Promise<T>;
    }

    const promise = runOnce(key, meta, fingerprint, executor).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, { promise, fingerprint });
    return promise;
  }

  return { execute, forget: (key) => backend.forget(key) };
}
