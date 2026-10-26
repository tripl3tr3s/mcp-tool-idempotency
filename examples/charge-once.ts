/**
 * Runnable demo (no infra): a "charge" side effect wrapped so that a retry with
 * the same idempotency key never fires it twice.
 *
 *   pnpm example
 */
import { createIdempotencyStore, MemoryBackend } from '../src/index.js';

const store = createIdempotencyStore(new MemoryBackend());

let timesCharged = 0;
// `idempotencyKey` stands in for the provider's own idempotency header (e.g.
// Stripe's `Idempotency-Key`). Forwarding it closes the window this library
// cannot see: a crash or timeout after the provider already committed.
async function chargeCard(
  orderId: string,
  idempotencyKey: string
): Promise<{ orderId: string; cents: number; idempotencyKey: string }> {
  timesCharged += 1;
  return { orderId, cents: 4999, idempotencyKey };
}

async function main(): Promise<void> {
  const key = 'order-123:charge';
  const meta = { toolName: 'charge', request: { orderId: 'order-123' } };

  const first = await store.execute(key, meta, (ctx) => chargeCard('order-123', ctx.key));
  // The client retried (timeout, double-click, LLM re-call) with the same key.
  const retry = await store.execute(key, meta, (ctx) => chargeCard('order-123', ctx.key));

  console.log('first result:  ', first);
  console.log('retry result:  ', retry, '(replayed)');
  console.log('times chargeCard() actually ran:', timesCharged); // -> 1
}

void main();
