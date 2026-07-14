# mcp-tool-idempotency

[![CI](https://github.com/tripl3tr3s/mcp-tool-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/tripl3tr3s/mcp-tool-idempotency/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25-brightgreen)
![types](https://img.shields.io/badge/types-included-blue)

Exactly-once execution for MCP tool calls (or any costly async op), so retries never fire
side effects twice. Pluggable storage; the default `MemoryBackend` needs no infra.

## The problem

When an LLM or a flaky network retries a tool call, side-effecting tools run again:
duplicate charges, duplicate records, duplicate emails. Idempotency keys fix this - but a
naive single-layer store still double-executes under **concurrent** retries in the same
process (both callers miss the cache before either writes).

`mcp-tool-idempotency` uses **two layers**:

1. **In-process in-flight map** - dedupes concurrent calls for the same key with zero
   storage round-trips. The second caller awaits the first caller's promise.
2. **Persistent backend** - an atomic `claim` (`INSERT ... ON CONFLICT DO NOTHING` on
   Postgres) plus a TTL, so a _completed_ result is replayed across restarts and only one
   caller ever wins the claim.

Failed executions are **never cached** - retries stay allowed. A crashed `pending` row is
detected and re-executed rather than wedging the key forever.

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
  () => chargeCard('123') // the side effect, run at most once
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
     dedup)          └────────────┬─────────────┘    (exactly-once across restarts)
                                  │ none
                                  ▼
                     ┌──────────────────────────┐  won            ──► run
                     │    backend.claim(key)    ├──► lost+completed──► replay
                     │  INSERT .. ON CONFLICT   │   lost+pending  ──► reset(key), then run
                     └────────────┬─────────────┘      (crashed holder)
                                  │ run the executor
                                  ▼
                     success ─► backend.complete(key, json) ─► return
                     throw   ─► backend.fail(key) ─► rethrow   (failures NOT cached)
```

## Design decisions

- **Two layers, not one.** The in-flight map closes the concurrent-retry race a DB-only
  store leaves open.
- **Atomic claim.** `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key` makes the
  check and the write one operation - no read-then-write TOCTOU.
- **Failures are not cached.** Only `completed` results are replayed; an errored tool stays
  retryable.
- **Crash recovery.** A `pending` row from a dead process is reset and re-run, so a key is
  never permanently wedged.
- **Storage-agnostic.** All persistence sits behind `IdempotencyBackend`; `MemoryBackend`
  needs no database, so the whole thing is testable with zero infra.

## API

```ts
function createIdempotencyStore(
  backend: IdempotencyBackend,
  options?: { ttlMs?: number; cleanupIntervalMs?: number }
): IdempotencyStore;

interface IdempotencyStore {
  execute<T>(
    key: string,
    meta: { toolName: string; request: object },
    executor: () => Promise<T>
  ): Promise<T>;
}
```

Ships: `MemoryBackend`, `PostgresBackend`, and the `IdempotencyBackend` / `SqlExecutor`
interfaces for custom stores.

## Backends

`MemoryBackend` (default) is fully in-memory - great for a single process and for tests.
For durability across restarts or instances, implement `IdempotencyBackend` (six methods)
over your store. A Postgres adapter ships as `PostgresBackend`:

```ts
import { createIdempotencyStore, PostgresBackend } from 'mcp-tool-idempotency';
import type { SqlExecutor } from 'mcp-tool-idempotency';

// Adapt any driver to the minimal SqlExecutor (parameters are always bound).
const sql: SqlExecutor = {
  query: (text, params) => pool.query(text, params).then((r) => r.rows),
};
const store = createIdempotencyStore(new PostgresBackend(sql), { ttlMs: 24 * 60 * 60 * 1000 });
```

Schema is in [`migrations/001_idempotency_keys.sql`](./migrations/001_idempotency_keys.sql).

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
