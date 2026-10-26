# mcp-tool-idempotency

[![CI](https://github.com/tripl3tr3s/mcp-tool-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/tripl3tr3s/mcp-tool-idempotency/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25-brightgreen)
![types](https://img.shields.io/badge/types-included-blue)

Idempotency for MCP tool calls (or any costly async op): a retry with the same key replays
the stored result instead of firing the side effect again, and at most one live execution
holds a key at a time, across processes and instances. Pluggable storage; the default
`MemoryBackend` needs no infra.

See [What is guaranteed](#what-is-guaranteed) for the exact boundaries.

## The problem

When an LLM or a flaky network retries a tool call, side-effecting tools run again:
duplicate charges, duplicate records, duplicate emails. Idempotency keys fix this - but a
naive single-layer store still double-executes under **concurrent** retries in the same
process (both callers miss the cache before either writes).

`mcp-tool-idempotency` uses **two layers**:

1. **In-process in-flight map** - dedupes concurrent calls for the same key with zero
   storage round-trips. The second caller awaits the first caller's promise.
2. **Persistent backend** - an atomic `claim` (`INSERT ... ON CONFLICT DO NOTHING` on
   Postgres) with an owner token and a renewing lease, plus a TTL. A _completed_ result is
   replayed across restarts and instances; a live holder is never taken over.

Failed executions are **not cached by default** - retries stay allowed. A holder that
crashed (its lease stopped renewing) is taken over by one conditional update rather than
wedging the key forever.

## Quickstart

```bash
pnpm add mcp-tool-idempotency
```

```ts
import { createIdempotencyStore, MemoryBackend } from 'mcp-tool-idempotency';

const store = createIdempotencyStore(new MemoryBackend());

const result = await store.execute(
  'order-123:charge', // idempotency key
  { toolName: 'charge', request: { orderId: '123' } },
  // the side effect; forward ctx.key to the provider's own idempotency header if it has one
  (ctx) => chargeCard('123', { idempotencyKey: ctx.key })
);
// A retry with the same key replays `result` without calling chargeCard again.
```

Run the offline demo:

```bash
pnpm example
```

## How it works

```
                     execute(key, meta, executor)
                                 │
                                 ▼
    Layer 1          ┌──────────────────────────┐  hit
  (same-process      │  in-flight map has key?  ├──► await the in-flight promise
     dedup)          └────────────┬─────────────┘    (concurrent dedup)
                                  │ miss
                                  ▼
    Layer 2          ┌──────────────────────────┐  completed
 (cross-restart      │    backend.check(key)    ├──► replay stored response
     dedup)          └────────────┬─────────────┘    (replayed across restarts)
                                  │ none
                                  ▼
                     ┌──────────────────────────┐  won                      ──► run
                     │    backend.claim(key)    ├──► lost+completed         ──► replay
                     │  INSERT .. ON CONFLICT   │   lost+uncertain         ──► throw Uncertain
                     └────────────┬─────────────┘   lost+pending, live lease ──► throw InFlight
                                  │                  (or wait inFlightWaitMs, then replay)
                                  │                 lost+failed / lease expired
                                  │                  ──► takeOver (conditional UPDATE), then run
                                  │ run the executor, renewing the lease every leaseMs/3
                                  ▼
          success ─► backend.complete(key, owner, json) ─► return
                     (owner lost the row? ─► throw LeaseLost with .result)
          throw   ─► isRetryable(err) false? ─► markUncertain ─► rethrow
                     otherwise              ─► fail           ─► rethrow (retryable)
```

## What is guaranteed

- **One live holder per key.** Claims are atomic and carry an owner token and a lease that
  the store renews while the executor runs. Another process or instance that loses the
  claim never resets a live holder: it gets `IdempotencyInFlightError` (or waits, see
  `inFlightWaitMs`).
- **Completed results replay** for `ttlMs` (default 24h), across restarts and instances.
  After the TTL the key is new again.
- **Only the owner can write.** `complete` / `fail` / `markUncertain` are gated on the owner
  token, so a holder that lost its lease cannot overwrite the new holder's result; it gets
  `IdempotencyLeaseLostError` instead of a clean success. The lease is lost only if renewals
  fail for a full `leaseMs` (e.g. the DB is unreachable or the event loop stalls); when a
  renewal finds another holder, `ctx.signal` is aborted so a long executor can stop before
  committing. That narrows the window but cannot close it for an effect already in flight.
- **A reused key with a different request** throws `IdempotencyConflictError` instead of
  replaying someone else's result (`verifyRequest`, on by default; object key order does not
  matter). Only a SHA-256 fingerprint of the request is stored, never the payload. Namespace
  keys per tenant: a conflict reveals that a key exists.

Leases compare epoch-millisecond timestamps written by different machines, so keep clock
drift between instances well under `leaseMs` (NTP is plenty for the 60s default).

**What the library cannot know:** whether your side effect committed before the executor
threw or the process died. By default both cases are retried, which is **at-least-once in
that window**:

| Window                                                            | Default               | Safe mode                                                                                   |
| ----------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| Executor throws after the provider committed (e.g. lost response) | retried               | `isRetryable` returns `false` -> row `uncertain`, retries throw `IdempotencyUncertainError` |
| Process crashes after the provider committed                      | lease expires, re-run | `onLeaseExpired: 'uncertain'` -> same as above                                              |

If the executor succeeds but its result cannot be stored (the backend keeps failing), the
store retries, then marks the key `uncertain` so it is not re-run.

An `uncertain` key stays blocked until you reconcile with the provider and call
`store.forget(key)`, or `uncertainTtlMs` (default 30 days) expires. The strongest fix is to forward `ctx.key` to a
provider that honors idempotency keys itself (Stripe, Adyen, most payment APIs): then a
retry in either window is deduplicated on their side too.

**Callers across instances must handle `IdempotencyInFlightError`.** It means nothing ran
here because another live execution holds the key; retry after a short delay to replay its
result, or set `inFlightWaitMs` to have the store wait for you. In an MCP server, surface it
as a retryable tool error rather than a hard failure.

## Design decisions

- **Two layers, not one.** The in-flight map closes the concurrent-retry race a DB-only
  store leaves open.
- **Atomic claim.** `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key` makes the
  check and the write one operation - no read-then-write TOCTOU.
- **Leases, not guesses.** "Not completed yet" is not proof that a holder crashed. Takeover
  happens only after the holder's lease expired, through one conditional update that only
  one contender can win.
- **Failures are retryable by default, classifiable when it matters.** Ordinary retryable
  work keeps working; payment-style executors opt into `uncertain` via `isRetryable`.
- **Crash recovery.** A holder whose lease expired is taken over (or flagged `uncertain`),
  so a key is never permanently wedged.
- **Storage-agnostic.** All persistence sits behind `IdempotencyBackend`; `MemoryBackend`
  needs no database, so the whole thing is testable with zero infra.

## API

```ts
function createIdempotencyStore(
  backend: IdempotencyBackend,
  options?: {
    ttlMs?: number; // result replay window, default 24h
    cleanupIntervalMs?: number; // periodic cleanupExpired(), off by default
    leaseMs?: number; // claim lease, renewed every leaseMs/3, default 60s
    onLeaseExpired?: 'retry' | 'uncertain'; // crashed holder: re-run (default) or block
    isRetryable?: (error: unknown) => boolean; // false -> uncertain; default: all retryable
    uncertainTtlMs?: number; // how long an uncertain key stays blocked, default 30 days
    verifyRequest?: boolean; // conflict on a reused key with a new request, default true
    inFlightWaitMs?: number; // wait for a live holder instead of throwing, default 0
    inFlightPollMs?: number; // poll interval while waiting, default 100ms
  }
): IdempotencyStore;

interface IdempotencyStore {
  execute<T>(
    key: string,
    meta: { toolName: string; request: Record<string, unknown> },
    executor: (ctx: { key: string; owner: string; signal: AbortSignal }) => Promise<T>
  ): Promise<T>;
  forget(key: string): Promise<void>; // clear a key, e.g. after reconciling an uncertain one
  // (forgetting a key that is still running lets another caller claim it; don't)
}
```

Errors (all extend `IdempotencyError` and carry `.key`):

| Error                       | Meaning                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `IdempotencyInFlightError`  | Another live execution holds the key. Nothing ran. Retry later.                                                 |
| `IdempotencyUncertainError` | A previous attempt may have committed. Reconcile, then `forget(key)`.                                           |
| `IdempotencyConflictError`  | The key was reused with a different request.                                                                    |
| `IdempotencyLeaseLostError` | This execution ran but lost the key before storing; `.result` holds its outcome. Raise `leaseMs` if you see it. |

An executor that resolves `undefined` is stored and replayed as `null`.

Ships: `MemoryBackend`, `PostgresBackend`, and the `IdempotencyBackend` / `SqlExecutor`
interfaces for custom stores.

## Backends

`MemoryBackend` (default) is fully in-memory - great for a single process and for tests.
For durability across restarts or instances, implement `IdempotencyBackend` over your store
(`backend-contract.test.ts` is the behavior a backend must satisfy; `takeOver` and the
owner-gated writes must each be atomic). A Postgres adapter ships as `PostgresBackend`:

```ts
import { createIdempotencyStore, PostgresBackend } from 'mcp-tool-idempotency';
import type { SqlExecutor } from 'mcp-tool-idempotency';

// Adapt any driver to the minimal SqlExecutor (parameters are always bound).
const sql: SqlExecutor = {
  query: (text, params) => pool.query(text, params).then((r) => r.rows),
};
const store = createIdempotencyStore(new PostgresBackend(sql), { ttlMs: 24 * 60 * 60 * 1000 });
```

Schema: run [`migrations/001_idempotency_keys.sql`](./migrations/001_idempotency_keys.sql),
then [`migrations/002_lease_and_uncertain.sql`](./migrations/002_lease_and_uncertain.sql).
`SqlExecutor.query` must return the rows of `RETURNING` clauses.

## Upgrading from 0.1.0

0.1.0 could run an executor twice when two instances shared a backend, and re-ran any
unfinished row without checking whether its holder was still alive (see
[SECURITY.md](./SECURITY.md)). Upgrade steps:

1. **Stop every 0.1.x process that uses the table first.** 0.1.x code still resets live
   rows, and its claims have no lease, so 0.2.0 treats them as crashed. Running both at
   once keeps the old bug alive during the deploy.
2. Run `migrations/002_lease_and_uncertain.sql`, then start 0.2.0 (it needs the new
   columns). Existing `pending` rows have no lease and are treated as crashed, so they stay
   recoverable.
3. Handle `IdempotencyInFlightError` in callers that share a backend (or set
   `inFlightWaitMs`).
4. Custom backends: `reset` is gone; implement `takeOver`, `renew`, `markUncertain` (which
   also sets the row's expiry) and `forget`, and gate `complete` / `fail` on the owner.
5. Rows written by 0.1.0 store the raw request rather than a fingerprint; they are replayed
   without request verification until their TTL expires.

## Develop

```bash
pnpm install
pnpm run build          # tsup -> dist (ESM + .d.ts)
pnpm run typecheck
pnpm run test
pnpm run test:coverage  # 90% gate
pnpm run lint
```

## License

MIT
