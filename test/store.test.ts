import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore, MemoryBackend } from '../src/index.js';
import type { ExecuteMeta } from '../src/index.js';

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
    const meta = { toolName: 't', request: '{}', expiresAt: Date.now() + 1000 };
    const [a, b] = await Promise.all([backend.claim('k', meta), backend.claim('k', meta)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('7. resets and re-runs a stale pending row left by a crashed process', async () => {
    const backend = new MemoryBackend();
    // Simulate a crash: a pending row that never completed.
    await backend.claim('k', { toolName: 'charge', request: '{}', expiresAt: Date.now() + 100_000 });

    const store = createIdempotencyStore(backend);
    const executor = vi.fn(() => Promise.resolve({ recovered: true }));
    const result = await store.execute('k', META, executor);

    expect(result).toEqual({ recovered: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it('8. ignores an expired record and cleanupExpired removes it', async () => {
    const backend = new MemoryBackend();
    await backend.claim('k', { toolName: 't', request: '{}', expiresAt: Date.now() - 1 });
    await backend.complete('k', JSON.stringify({ old: true }));

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
});
