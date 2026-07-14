/**
 * Runnable demo (no infra): a "charge" side effect wrapped so that a retry with
 * the same idempotency key never fires it twice.
 *
 *   pnpm example
 */
import { createIdempotencyStore, MemoryBackend } from '../src/index.js';

const store = createIdempotencyStore(new MemoryBackend());

let timesCharged = 0;
async function chargeCard(orderId: string): Promise<{ orderId: string; cents: number }> {
  timesCharged += 1;
  return { orderId, cents: 4999 };
}

async function main(): Promise<void> {
  const key = 'order-123:charge';
  const meta = { toolName: 'charge', request: { orderId: 'order-123' } };

  const first = await store.execute(key, meta, () => chargeCard('order-123'));
  // The client retried (timeout, double-click, LLM re-call) with the same key.
  const retry = await store.execute(key, meta, () => chargeCard('order-123'));

  console.log('first result:  ', first);
  console.log('retry result:  ', retry, '(replayed)');
  console.log('times chargeCard() actually ran:', timesCharged); // -> 1
}

void main();
