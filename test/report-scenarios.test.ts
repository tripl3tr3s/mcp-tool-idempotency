/**
 * Regression tests for the windows in the 2026-10 durability report against
 * 4d665ae (lost response after commit, crash after commit, cross-instance race,
 * unchecked request meta). Every scenario runs on both shipped backends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIdempotencyStore,
  fingerprintRequest,
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyLeaseLostError,
  IdempotencyUncertainError,
  MemoryBackend,
  PostgresBackend,
} from '../src/index.js';
import type { ExecuteMeta, IdempotencyBackend } from '../src/index.js';
import { FakeSql } from './fake-sql.js';

const META: ExecuteMeta = { toolName: 'charge', request: { orderId: 'order-123' } };
const HOUR = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Leave a `pending` row behind, as a holder that died mid-execution would. */
async function crashedHolder(backend: IdempotencyBackend, leaseExpiresAt: number) {
  await backend.claim('order-123', {
    toolName: 'charge',
    request: fingerprintRequest(META.request),
    owner: 'dead-process',
    leaseExpiresAt,
    expiresAt: Date.now() + HOUR,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

const backends: Array<[string, () => IdempotencyBackend]> = [
  ['MemoryBackend', () => new MemoryBackend()],
  ['PostgresBackend', () => new PostgresBackend(new FakeSql())],
];

describe.each(backends)('report scenarios: %s', (_name, make) => {
  describe('F3 - cross-instance race', () => {
    it('two instances on one backend: one execution, the loser gets InFlight', async () => {
      const backend = make();
      const storeA = createIdempotencyStore(backend);
      const storeB = createIdempotencyStore(backend);
      let charges = 0;

      const [ra, rb] = await Promise.allSettled([
        storeA.execute('order-123', META, async () => {
          charges += 1;
          await sleep(50);
          return { charged: 'A' };
        }),
        storeB.execute('order-123', META, async () => {
          charges += 1;
          await sleep(5);
          return { charged: 'B' };
        }),
      ]);

      expect(charges).toBe(1);
      expect(ra).toEqual({ status: 'fulfilled', value: { charged: 'A' } });
      expect(rb.status).toBe('rejected');
      expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyInFlightError);

      // Once the winner finished, the loser's retry replays the winner's result.
      const retry = await storeB.execute('order-123', META, () =>
        Promise.resolve({ charged: 'B' })
      );
      expect(retry).toEqual({ charged: 'A' });
      expect(charges).toBe(1);
    });

    it('a live lease is never taken over', async () => {
      const backend = make();
      await crashedHolder(backend, Date.now() + HOUR);
      const executor = vi.fn(() => Promise.resolve(1));
      await expect(
        createIdempotencyStore(backend).execute('order-123', META, executor)
      ).rejects.toBeInstanceOf(IdempotencyInFlightError);
      expect(executor).not.toHaveBeenCalled();
      expect((await backend.check('order-123'))?.owner).toBe('dead-process');
    });

    it('the heartbeat keeps a slow holder live past leaseMs', async () => {
      vi.useFakeTimers();
      const backend = make();
      const gate = deferred();
      const storeA = createIdempotencyStore(backend, { leaseMs: 300 });
      const storeB = createIdempotencyStore(backend, { leaseMs: 300 });
      const slow = storeA.execute('order-123', META, async () => {
        await gate.promise;
        return 'A';
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const executorB = vi.fn(() => Promise.resolve('B'));
      await expect(storeB.execute('order-123', META, executorB)).rejects.toBeInstanceOf(
        IdempotencyInFlightError
      );
      expect(executorB).not.toHaveBeenCalled();

      gate.resolve();
      await expect(slow).resolves.toBe('A');
    });

    it('a holder that lost its row gets LeaseLost (with the result), not a clean success', async () => {
      const backend = make();
      const store = createIdempotencyStore(backend);
      const outcome = store.execute('order-123', META, async () => {
        // Another instance takes the row over while this one is still running.
        await backend.forget('order-123');
        await crashedHolder(backend, Date.now() + HOUR);
        return { charged: 'zombie' };
      });

      const error = await outcome.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IdempotencyLeaseLostError);
      expect((error as IdempotencyLeaseLostError).result).toEqual({ charged: 'zombie' });
      expect((await backend.check('order-123'))?.owner).toBe('dead-process');
    });
  });

  describe('F2 - crash after commit', () => {
    it('default: an expired lease is taken over and re-run once', async () => {
      const backend = make();
      await crashedHolder(backend, Date.now() - 1);
      const executor = vi.fn(() => Promise.resolve({ recovered: true }));
      const store = createIdempotencyStore(backend);

      expect(await store.execute('order-123', META, executor)).toEqual({ recovered: true });
      expect(await store.execute('order-123', META, executor)).toEqual({ recovered: true });
      expect(executor).toHaveBeenCalledOnce();
    });

    it("onLeaseExpired: 'uncertain' blocks re-dispatch until forget()", async () => {
      const backend = make();
      await crashedHolder(backend, Date.now() - 1);
      const store = createIdempotencyStore(backend, { onLeaseExpired: 'uncertain' });
      const executor = vi.fn(() => Promise.resolve({ charged: true }));

      await expect(store.execute('order-123', META, executor)).rejects.toBeInstanceOf(
        IdempotencyUncertainError
      );
      await expect(store.execute('order-123', META, executor)).rejects.toBeInstanceOf(
        IdempotencyUncertainError
      );
      expect(executor).not.toHaveBeenCalled();

      await store.forget('order-123');
      expect(await store.execute('order-123', META, executor)).toEqual({ charged: true });
      expect(executor).toHaveBeenCalledOnce();
    });
  });

  describe('F1 - lost response after commit', () => {
    const lostResponse = () => {
      let charges = 0;
      const executor = async (): Promise<never> => {
        charges += 1;
        throw new Error('ETIMEDOUT: response lost after provider accepted');
      };
      return { executor, charges: () => charges };
    };

    it('default: failures stay retryable (documented at-least-once window)', async () => {
      const store = createIdempotencyStore(make());
      const { executor, charges } = lostResponse();
      await expect(store.execute('order-123', META, executor)).rejects.toThrow('ETIMEDOUT');
      await expect(store.execute('order-123', META, executor)).rejects.toThrow('ETIMEDOUT');
      expect(charges()).toBe(2);
    });

    it('isRetryable() => false marks the outcome uncertain and blocks the retry', async () => {
      const store = createIdempotencyStore(make(), {
        isRetryable: (error) => !(error instanceof Error && error.message.startsWith('ETIMEDOUT')),
      });
      const { executor, charges } = lostResponse();

      await expect(store.execute('order-123', META, executor)).rejects.toThrow('ETIMEDOUT');
      const retry = await store.execute('order-123', META, executor).catch((e: unknown) => e);
      expect(retry).toBeInstanceOf(IdempotencyUncertainError);
      expect((retry as IdempotencyUncertainError).key).toBe('order-123');
      expect(charges()).toBe(1);
    });

    it('isRetryable() => true keeps the failure retryable', async () => {
      const store = createIdempotencyStore(make(), { isRetryable: () => true });
      let n = 0;
      const executor = () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve('ok');
      };
      await expect(store.execute('order-123', META, executor)).rejects.toThrow('ECONNREFUSED');
      expect(await store.execute('order-123', META, executor)).toBe('ok');
    });

    it('the executor receives the key so it can forward it to the provider', async () => {
      const store = createIdempotencyStore(make());
      const executor = vi.fn((ctx: { key: string; owner: string }) => Promise.resolve(ctx.key));
      expect(await store.execute('order-123', META, executor)).toBe('order-123');
      expect(executor.mock.calls[0]?.[0].owner).toEqual(expect.any(String));
    });
  });

  describe('TTL boundary', () => {
    it('replays inside ttlMs and re-runs once the result expires', async () => {
      vi.useFakeTimers();
      const store = createIdempotencyStore(make(), { ttlMs: 1_000 });
      let charges = 0;
      const executor = () => {
        charges += 1;
        return Promise.resolve({ n: charges });
      };

      expect(await store.execute('order-123', META, executor)).toEqual({ n: 1 });
      await vi.advanceTimersByTimeAsync(999);
      expect(await store.execute('order-123', META, executor)).toEqual({ n: 1 });

      await vi.advanceTimersByTimeAsync(2);
      expect(await store.execute('order-123', META, executor)).toEqual({ n: 2 });
      expect(charges).toBe(2);
    });
  });

  describe('request meta mismatch', () => {
    it('replaying a key with a different request throws Conflict', async () => {
      const store = createIdempotencyStore(make());
      await store.execute('order-123', META, () => Promise.resolve('first'));
      await expect(
        store.execute('order-123', { toolName: 'charge', request: { orderId: 'other' } }, () =>
          Promise.resolve('second')
        )
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('a different key order in the request is the same request', async () => {
      const store = createIdempotencyStore(make());
      const a: ExecuteMeta = { toolName: 'charge', request: { a: 1, b: { c: 2, d: 3 } } };
      const b: ExecuteMeta = { toolName: 'charge', request: { b: { d: 3, c: 2 }, a: 1 } };
      await store.execute('k', a, () => Promise.resolve('first'));
      expect(await store.execute('k', b, () => Promise.resolve('second'))).toBe('first');
    });

    it('verifyRequest: false replays regardless of the request', async () => {
      const store = createIdempotencyStore(make(), { verifyRequest: false });
      await store.execute('order-123', META, () => Promise.resolve('first'));
      const other: ExecuteMeta = { toolName: 'charge', request: { orderId: 'other' } };
      expect(await store.execute('order-123', other, () => Promise.resolve('second'))).toBe(
        'first'
      );
    });

    it('a live holder with a different request throws Conflict, not InFlight', async () => {
      const backend = make();
      await crashedHolder(backend, Date.now() + HOUR);
      const other: ExecuteMeta = { toolName: 'charge', request: { orderId: 'other' } };
      await expect(
        createIdempotencyStore(backend).execute('order-123', other, () => Promise.resolve(1))
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });
  });
});

describe('in-process (Layer 1) request mismatch', () => {
  it('a concurrent same-key call with a different request throws Conflict', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const gate = deferred();
    const first = store.execute('k', META, async () => {
      await gate.promise;
      return 'first';
    });
    const other: ExecuteMeta = { toolName: 'charge', request: { orderId: 'other' } };
    await expect(store.execute('k', other, () => Promise.resolve('x'))).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    gate.resolve();
    await expect(first).resolves.toBe('first');
  });
});
