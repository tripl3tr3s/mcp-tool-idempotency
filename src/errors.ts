/**
 * JSON-encode the key for messages so newlines or control characters in a
 * caller-supplied key cannot forge log lines. Long keys are truncated; the full
 * key is always on `.key`.
 */
function quoteKey(key: string): string {
  return JSON.stringify(key.length > 200 ? `${key.slice(0, 200)}...` : key);
}

/** Base class for every error the store raises itself. Carries the idempotency key. */
export class IdempotencyError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.key = key;
  }
}

/**
 * Another live execution (possibly in another process or instance) holds the
 * key. Nothing ran. Retry later to replay its result, or set `inFlightWaitMs`.
 */
export class IdempotencyInFlightError extends IdempotencyError {
  constructor(key: string) {
    super(key, `Idempotency key ${quoteKey(key)} is held by another live execution; retry later.`);
  }
}

/**
 * A previous execution may or may not have committed its side effect. The key
 * is blocked until you reconcile with the provider and call `store.forget(key)`
 * (or the TTL expires).
 */
export class IdempotencyUncertainError extends IdempotencyError {
  constructor(key: string) {
    super(
      key,
      `Outcome for idempotency key ${quoteKey(key)} is uncertain; reconcile it, then call store.forget(key).`
    );
  }
}

/** The key was reused with a different request than the one stored for it. */
export class IdempotencyConflictError extends IdempotencyError {
  constructor(key: string) {
    super(key, `Idempotency key ${quoteKey(key)} was reused with a different request.`);
  }
}

/**
 * The executor finished, but this caller no longer owned the key when it tried
 * to store the result (its lease expired and another holder took over). The
 * side effect may have run twice; `result` is this caller's outcome.
 */
export class IdempotencyLeaseLostError<T = unknown> extends IdempotencyError {
  readonly result: T;

  constructor(key: string, result: T) {
    super(key, `Lost the lease on idempotency key ${quoteKey(key)} before the result was stored.`);
    this.result = result;
  }
}
