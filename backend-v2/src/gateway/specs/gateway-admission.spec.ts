import { expect, it } from 'vitest';
import { GatewayAdmission } from '../types/gateway-admission.js';
it('bounds active and queued requests and recovers after release', async () => {
  const gate = new GatewayAdmission(),
    signal = new AbortController().signal;
  const a = await gate.acquire('a', 1, 1, 1000, signal);
  const queued = gate.acquire('a', 1, 1, 1000, signal);
  expect(await gate.acquire('a', 1, 1, 1000, signal)).toBeUndefined();
  expect(gate.snapshot()).toEqual([
    { applicationId: 'a', active: 1, queued: 1 },
  ]);
  const other = await gate.acquire('b', 1, 1, 1000, signal);
  expect(other).toBeTypeOf('function');
  other!();
  a!();
  a!();
  const b = await queued;
  expect(b).toBeTypeOf('function');
  b!();
  expect(gate.snapshot()).toEqual([]);
});
it('removes timed out and canceled waiters without consuming later slots', async () => {
  const gate = new GatewayAdmission(),
    controller = new AbortController();
  const release = await gate.acquire('a', 1, 2, 10, controller.signal);
  const canceled = gate.acquire('a', 1, 2, 1000, controller.signal);
  controller.abort();
  expect(await canceled).toBeUndefined();
  const timeout = gate.acquire('a', 1, 2, 10, new AbortController().signal);
  // Keep the event loop alive for an unref admission timeout.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await timeout).toBeUndefined();
  release!();
  expect(gate.snapshot()).toEqual([]);
  expect(
    await gate.acquire('a', 1, 0, 1000, controller.signal),
  ).toBeUndefined();
});
