// -----------------------------------------------------------------------------
// The real clock against the simulated DigitalOcean: the period of the reads
// measured (60 times faster, wide margins: a timer is late under load, never
// early), a command acked within the 3.5 s budget when DigitalOcean never
// answers, and nothing left running after shutdown. The app is stopped in
// t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DoApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { TOKEN, did, fakeDo } from './helpers/fakeDo.js';
import { allCreated, waitFor, within } from './helpers/setup.js';

async function start(t, { speed = 60, config = {} } = {}) {
  const fake = await fakeDo();
  t.after(() => fake.close());
  const clock = realClock({ speed });
  t.after(() => clock.close());
  const raw = { token: TOKEN, poll_interval: 60, ...config };
  const devices = allCreated();
  const gladys = createFakeGladys({ config: raw, devices });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new DoApp({
    gladys,
    logger,
    store: memoryStore(),
    now: clock.now,
    mono: clock.monotonic,
    timers: clock.timers,
    api: fake.origin,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.shutdown());
  return { fake, clock, gladys, app, devices };
}

test('real clock x60: the reads come at the interval (60 s), measured', async (t) => {
  const { clock, gladys, app } = await start(t);
  const spy = spyOn(app, 'tick', clock);
  t.after(() => spy.restore());
  await within(gladys.connect(), 'connect');
  const gaps = await measurePeriod(spy, { count: 4, period: 60_000, timeoutMs: 20_000 });
  assert.equal(gaps.length, 3);
});

test('real clock: a stop DigitalOcean never answers is acked within the 3.5 s budget, sent once', async (t) => {
  const { fake, gladys, app, devices } = await start(t, {
    speed: 1,
    config: { allow_shutdown: true },
  });
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  fake.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  fake.latencyMs = (r) => (r.method === 'GET' ? 400 : 0);
  const d = devices.find((x) => x.external_id.endsWith(did(1)));
  const started = performance.now();
  const res = await within(
    gladys.fake.setValue(d, { external_id: `${d.external_id}:shutdown` }, 1),
    'ack',
  );
  const took = performance.now() - started;
  assert.equal(res.success, false);
  assert.ok(took < 3600, `acked after ${Math.round(took)} ms`);
  assert.equal(fake.count('POST'), 1);
});

test('real clock: stop() leaves no timer: no request after shutdown', async (t) => {
  const { fake, gladys, app, clock } = await start(t);
  await within(gladys.connect(), 'connect');
  await waitFor(() => app.online, 'online', 6000);
  await app.shutdown();
  const asked = fake.requests.length;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fake.requests.length, asked);
  assert.ok(clock.timersSet > 0);
});
