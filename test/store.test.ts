import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIdempotencyStore,
  fingerprintRequest,
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyLeaseLostError,
  IdempotencyUncertainError,
  MemoryBackend,
  stableStringify,
} from '../src/index.js';
import type { ExecuteMeta, IdempotencyBackend, StoredRecord } from '../src/index.js';

const META: ExecuteMeta = { toolName: 'charge', request: { amount: 100 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createIdempotencyStore (MemoryBackend)', () => {
  it('1. runs the executor on the first call and returns its result', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const executor = vi.fn(() => Promise.resolve({ id: 'a' }));
    const result = await store.execute('k1', META, executor);
    expect(result).toEqual({ id: 'a' });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('2. replays the stored result on a second call (executor runs once)', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const executor = vi.fn(() => Promise.resolve({ id: 'a' }));
    await store.execute('k1', META, executor);
    const second = await store.execute('k1', META, executor);
    expect(second).toEqual({ id: 'a' });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('3. dedupes concurrent same-key calls through one in-flight promise', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const gate = deferred<void>();
    const executor = vi.fn(async () => {
      await gate.promise;
      return { id: 'x' };
    });

    const p1 = store.execute('k', META, executor);
    const p2 = store.execute('k', META, executor);
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(executor).toHaveBeenCalledOnce();
    expect(r1).toEqual(r2);
  });

  it('4. runs independently for different keys', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const executor = vi.fn(() => Promise.resolve({ ok: true }));
    await store.execute('k1', META, executor);
    await store.execute('k2', META, executor);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('5. does not cache a failed execution - the next call re-runs', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    let n = 0;
    const executor = vi.fn(() => {
      n += 1;
      return n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
    });

    await expect(store.execute('k', META, executor)).rejects.toThrow('boom');
    const retry = await store.execute('k', META, executor);

    expect(retry).toEqual({ ok: true });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('6. claim is atomic: two concurrent claims, exactly one wins', async () => {
    const backend = new MemoryBackend();
    const meta = {
      toolName: 't',
      request: '{}',
      owner: 'o',
      leaseExpiresAt: Date.now() + 1000,
      expiresAt: Date.now() + 1000,
    };
    const [a, b] = await Promise.all([backend.claim('k', meta), backend.claim('k', meta)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('7. takes over and re-runs a pending row whose lease expired (crashed process)', async () => {
    const backend = new MemoryBackend();
    // Simulate a crash: a pending row that never completed and stopped renewing.
    await backend.claim('k', {
      toolName: 'charge',
      request: '{"amount":100}',
      owner: 'dead',
      leaseExpiresAt: Date.now() - 1,
      expiresAt: Date.now() + 100_000,
    });

    const store = createIdempotencyStore(backend);
    const executor = vi.fn(() => Promise.resolve({ recovered: true }));
    const result = await store.execute('k', META, executor);

    expect(result).toEqual({ recovered: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('8. ignores an expired record and cleanupExpired removes it', async () => {
    const backend = new MemoryBackend();
    await backend.claim('k', {
      toolName: 't',
      request: '{}',
      owner: 'o',
      leaseExpiresAt: Date.now() + 1000,
      expiresAt: Date.now() - 1,
    });
    await backend.complete('k', 'o', JSON.stringify({ old: true }));

    expect(await backend.check('k')).toBeUndefined(); // expired -> not returned
    expect(backend.size()).toBe(1);
    await backend.cleanupExpired();
    expect(backend.size()).toBe(0);
  });

  it('9. rethrows the executor error to the caller', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    await expect(
      store.execute('k', META, () => Promise.reject(new Error('kaboom')))
    ).rejects.toThrow('kaboom');
  });

  it('schedules periodic cleanup only when an interval is configured', async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    const spy = vi.spyOn(backend, 'cleanupExpired');
    const store = createIdempotencyStore(backend, { cleanupIntervalMs: 1000 });

    await store.execute('k', META, () => Promise.resolve(1));
    // A second execute must not schedule a second timer.
    await store.execute('k', META, () => Promise.resolve(1));

    vi.advanceTimersByTime(2500);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('replays a void executor instead of re-running it', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    const executor = vi.fn(() => Promise.resolve(undefined));
    await store.execute('k', META, executor);
    expect(await store.execute('k', META, executor)).toBeNull();
    expect(executor).toHaveBeenCalledOnce();
  });

  it('stableStringify sorts nested object keys and keeps arrays in order', () => {
    expect(stableStringify({ b: [2, { y: 1, x: 0 }], a: null })).toBe(
      '{"a":null,"b":[2,{"x":0,"y":1}]}'
    );
    expect(stableStringify(undefined)).toBe('null');
  });
});

/** Another instance holding 'k' with a live lease. */
const holder = (backend: IdempotencyBackend) =>
  backend.claim('k', {
    toolName: 'charge',
    request: fingerprintRequest(META.request),
    owner: 'other-instance',
    leaseExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
  });

describe('inFlightWaitMs', () => {
  it('waits for a live holder in another instance and replays its result', async () => {
    const backend = new MemoryBackend();
    await holder(backend);
    setTimeout(() => void backend.complete('k', 'other-instance', JSON.stringify('theirs')), 30);

    const store = createIdempotencyStore(backend, { inFlightWaitMs: 1_000, inFlightPollMs: 10 });
    const executor = vi.fn(() => Promise.resolve('mine'));
    expect(await store.execute('k', META, executor)).toBe('theirs');
    expect(executor).not.toHaveBeenCalled();
  });

  it('throws InFlight when the holder is still running at the deadline', async () => {
    const backend = new MemoryBackend();
    await holder(backend);
    const store = createIdempotencyStore(backend, { inFlightWaitMs: 40, inFlightPollMs: 10 });
    await expect(store.execute('k', META, () => Promise.resolve(1))).rejects.toBeInstanceOf(
      IdempotencyInFlightError
    );
  });

  it('takes over and runs when the holder fails while we wait', async () => {
    const backend = new MemoryBackend();
    await holder(backend);
    setTimeout(() => void backend.fail('k', 'other-instance'), 20);
    const store = createIdempotencyStore(backend, { inFlightWaitMs: 5_000, inFlightPollMs: 10 });
    const started = Date.now();
    expect(await store.execute('k', META, () => Promise.resolve('retried'))).toBe('retried');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('takes over when the holder stops renewing (crashed) while we wait', async () => {
    const backend = new MemoryBackend();
    await backend.claim('k', {
      toolName: 'charge',
      request: fingerprintRequest(META.request),
      owner: 'dying-instance',
      leaseExpiresAt: Date.now() + 30,
      expiresAt: Date.now() + 60_000,
    });
    const store = createIdempotencyStore(backend, { inFlightWaitMs: 1_000, inFlightPollMs: 10 });
    expect(await store.execute('k', META, () => Promise.resolve('took over'))).toBe('took over');
  });

  it('clamps a zero or NaN poll interval instead of busy-looping', async () => {
    for (const inFlightPollMs of [0, Number.NaN]) {
      const backend = new MemoryBackend();
      await holder(backend);
      const store = createIdempotencyStore(backend, { inFlightWaitMs: 30, inFlightPollMs });
      const check = vi.spyOn(backend, 'check');
      await expect(store.execute('k', META, () => Promise.resolve(1))).rejects.toBeInstanceOf(
        IdempotencyInFlightError
      );
      expect(check.mock.calls.length).toBeLessThan(40);
    }
  });

  it('surfaces Uncertain when the holder ends uncertain', async () => {
    const backend = new MemoryBackend();
    await holder(backend);
    setTimeout(() => void backend.markUncertain('k', 'other-instance', Date.now() + 60_000), 20);
    const store = createIdempotencyStore(backend, { inFlightWaitMs: 1_000, inFlightPollMs: 10 });
    await expect(store.execute('k', META, () => Promise.resolve(1))).rejects.toBeInstanceOf(
      IdempotencyUncertainError
    );
  });
});

describe('takeover races', () => {
  it('replays when another contender completes between check and takeOver', async () => {
    const failed: StoredRecord = {
      key: 'k',
      status: 'failed',
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
    };
    const completed: StoredRecord = { ...failed, status: 'completed', response: '"winner"' };
    const checks = [undefined, failed, completed];
    const backend: IdempotencyBackend = {
      ...new MemoryBackend(),
      check: () => Promise.resolve(checks.shift()),
      claim: () => Promise.resolve(false),
      takeOver: () => Promise.resolve(false),
      renew: () => Promise.resolve(true),
      complete: () => Promise.resolve(true),
      fail: () => Promise.resolve(),
      markUncertain: () => Promise.resolve(true),
      forget: () => Promise.resolve(),
      cleanupExpired: () => Promise.resolve(),
    };
    const executor = vi.fn(() => Promise.resolve('mine'));
    expect(await createIdempotencyStore(backend).execute('k', META, executor)).toBe('winner');
    expect(executor).not.toHaveBeenCalled();
  });

  it('throws InFlight when takeOver loses and nobody has completed yet', async () => {
    const backend = new MemoryBackend();
    vi.spyOn(backend, 'claim').mockResolvedValue(false);
    vi.spyOn(backend, 'takeOver').mockResolvedValue(false);
    await expect(
      createIdempotencyStore(backend).execute('k', META, () => Promise.resolve(1))
    ).rejects.toBeInstanceOf(IdempotencyInFlightError);
  });
});

describe('backend errors and lease loss (review findings)', () => {
  it('aborts ctx.signal when a renewal finds another holder', async () => {
    const backend = new MemoryBackend();
    const store = createIdempotencyStore(backend, { leaseMs: 30 });
    let aborted: unknown;
    const outcome = store.execute('k', META, async (ctx) => {
      await backend.forget('k');
      await holder(backend);
      await new Promise((r) => setTimeout(r, 60));
      aborted = ctx.signal.reason;
      return 'zombie';
    });
    await expect(outcome).rejects.toBeInstanceOf(IdempotencyLeaseLostError);
    expect(aborted).toBeInstanceOf(IdempotencyLeaseLostError);
  });

  it('keeps going when a renewal throws (transient DB error)', async () => {
    const backend = new MemoryBackend();
    vi.spyOn(backend, 'renew').mockRejectedValue(new Error('db blip'));
    const store = createIdempotencyStore(backend, { leaseMs: 30 });
    const result = await store.execute('k', META, async (ctx) => {
      await new Promise((r) => setTimeout(r, 60));
      return ctx.signal.aborted;
    });
    expect(result).toBe(false);
  });

  it('retries a failing complete() and returns the result once it lands', async () => {
    const backend = new MemoryBackend();
    const real = backend.complete.bind(backend);
    vi.spyOn(backend, 'complete')
      .mockRejectedValueOnce(new Error('db blip'))
      .mockImplementation(real);
    const executor = vi.fn(() => Promise.resolve('charged'));
    const store = createIdempotencyStore(backend);
    expect(await store.execute('k', META, executor)).toBe('charged');
    expect(await store.execute('k', META, executor)).toBe('charged');
    expect(executor).toHaveBeenCalledOnce();
  });

  it('marks the key uncertain when complete() keeps failing, so it is not re-run', async () => {
    const backend = new MemoryBackend();
    vi.spyOn(backend, 'complete').mockRejectedValue(new Error('db down'));
    const executor = vi.fn(() => Promise.resolve('charged'));
    const store = createIdempotencyStore(backend);
    await expect(store.execute('k', META, executor)).rejects.toThrow('db down');
    await expect(store.execute('k', META, executor)).rejects.toBeInstanceOf(
      IdempotencyUncertainError
    );
    expect(executor).toHaveBeenCalledOnce();
  });

  it('surfaces the executor error even when fail() or markUncertain() throws', async () => {
    const backend = new MemoryBackend();
    vi.spyOn(backend, 'fail').mockRejectedValue(new Error('db down'));
    vi.spyOn(backend, 'markUncertain').mockRejectedValue(new Error('db down'));
    const boom = () => Promise.reject(new Error('executor boom'));
    await expect(createIdempotencyStore(backend).execute('a', META, boom)).rejects.toThrow(
      'executor boom'
    );
    const strict = createIdempotencyStore(backend, { isRetryable: () => false });
    await expect(strict.execute('b', META, boom)).rejects.toThrow('executor boom');
  });

  it('a failing cleanupExpired() does not cause an unhandled rejection', async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    const sweep = vi.spyOn(backend, 'cleanupExpired').mockRejectedValue(new Error('db down'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const store = createIdempotencyStore(backend, { cleanupIntervalMs: 100 });
      await store.execute('k', META, () => Promise.resolve(1));
      await vi.advanceTimersByTimeAsync(350);
      expect(sweep).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects (never throws synchronously) on an unserializable request', async () => {
    const store = createIdempotencyStore(new MemoryBackend());
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = store.execute('k', { toolName: 't', request: { n: 1n } }, () => Promise.resolve(1));
    }).not.toThrow();
    await expect(pending).rejects.toThrow(TypeError);
  });

  it('keeps an uncertain key blocked for uncertainTtlMs, not the result TTL', async () => {
    const backend = new MemoryBackend();
    const store = createIdempotencyStore(backend, {
      ttlMs: 1_000,
      uncertainTtlMs: 60_000,
      isRetryable: () => false,
    });
    await store.execute('k', META, () => Promise.reject(new Error('x'))).catch(() => undefined);
    const record = await backend.check('k');
    expect(record?.status).toBe('uncertain');
    expect(record!.expiresAt - Date.now()).toBeGreaterThan(30_000);
  });

  it('stores a sha256 fingerprint, never the raw request', async () => {
    const backend = new MemoryBackend();
    const secret: ExecuteMeta = { toolName: 'charge', request: { pan: '4242424242424242' } };
    await createIdempotencyStore(backend).execute('k', secret, () => Promise.resolve(1));
    const stored = (await backend.check('k'))?.request;
    expect(stored).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored).not.toContain('4242');
  });

  it('skips request verification for 0.1.0 rows that hold the raw request', async () => {
    const backend = new MemoryBackend();
    await backend.claim('k', {
      toolName: 'charge',
      request: '{"amount":999}',
      owner: 'legacy',
      leaseExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
    });
    await backend.complete('k', 'legacy', '"old"');
    expect(
      await createIdempotencyStore(backend).execute('k', META, () => Promise.resolve('new'))
    ).toBe('old');
  });

  it('JSON-encodes the key in error messages (no forged log lines)', () => {
    const error = new IdempotencyConflictError('a\nFAKE LOG LINE');
    expect(error.message).not.toContain('\n');
    expect(error.message).toContain('\\n');
    expect(error.key).toBe('a\nFAKE LOG LINE');
    expect(new IdempotencyInFlightError('x'.repeat(500)).message.length).toBeLessThan(300);
  });
});
