// -----------------------------------------------------------------------------
// The droplet buttons: Power on allowed; Shut down, Force power off and Reboot
// behind options off by default, read again right before the first byte; a
// decision on a fresh read; the stop guard in /data before sending; done only
// once a later read shows it; the answer to Gladys within 3.5 s and never
// waiting for a publication nor a status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { did, droplet } from './helpers/fakeDo.js';
import { ack, online, pause, setup, statusText, until, waitFor, within } from './helpers/setup.js';

const ALL_ON = { allow_shutdown: true, allow_power_off: true, allow_reboot: true };

test('the stops are off by default: refused, nothing read nor sent', async (t) => {
  const ctx = await online(t);
  const asked = ctx.fake.requests.length;
  for (const key of ['shutdown', 'power_off', 'reboot']) {
    const res = await ack(ctx, ctx.press(1, key));
    assert.equal(res.success, false, key);
    assert.match(JSON.stringify(res), /off in the configuration/, key);
  }
  assert.equal(ctx.fake.requests.length, asked);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('Power on: sent on a fresh read; done only once a later read shows it', async (t) => {
  const ctx = await online(t, { server: { applyDelayMs: 50_000 } });
  const res = await ack(ctx, ctx.press(2, 'power_on'));
  assert.equal(res.success, true);
  assert.equal(ctx.fake.count('POST /v2/droplets/' + did(2) + '/actions'), 1);
  const post = ctx.fake.requests.find((r) => r.method === 'POST');
  const read = ctx.fake.requests.findLast(
    (r) => r.path === `/v2/droplets/${did(2)}` && r.at < post.at,
  );
  assert.ok(read, 'read before sending');
  assert.match(statusText(ctx), /taken by DigitalOcean; done once a read shows it/);
  // The follow-up at 5 s reads "off" (not applied yet): not done.
  await until(ctx, () => ctx.fake.count(`GET /v2/droplets/${did(2)}`) >= 2, 'follow-up', {
    step: 1000,
  });
  await pause(30);
  assert.doesNotMatch(statusText(ctx), /done, the droplet reads so/);
  // Applied later: the next follow-up confirms it.
  ctx.fake.droplet(2).status = 'active';
  await until(
    ctx,
    () => /Power on: done, the droplet reads so/.test(statusText(ctx)),
    'confirmed',
    { step: 2000 },
  );
});

test('a power on that never applies ends "not applied yet"', async (t) => {
  const ctx = await online(t, { server: { applyDelayMs: 10_000_000 } });
  await ack(ctx, ctx.press(2, 'power_on'));
  await until(
    ctx,
    () => /not applied yet \(droplet read: Off\)/.test(statusText(ctx)),
    'not applied',
    {
      step: 5000,
      timeout: 8000,
    },
  );
});

test('Reboot: done only once its action reads completed and the droplet runs', async (t) => {
  const ctx = await online(t, {
    config: { allow_reboot: true },
    server: { applyDelayMs: 10_000_000 },
  });
  await ack(ctx, ctx.press(1, 'reboot'));
  await until(ctx, () => ctx.fake.count('/actions/') >= 1, 'action read', { step: 1000 });
  await pause(30);
  assert.doesNotMatch(
    statusText(ctx),
    /Reboot: done/,
    'the droplet reads running, but the action is in progress',
  );
  ctx.fake.actions[0].status = 'completed';
  await until(ctx, () => /Reboot: done, the droplet reads so/.test(statusText(ctx)), 'confirmed', {
    step: 2000,
  });
});

test('an action errored at DigitalOcean is said failed, never done', async (t) => {
  const ctx = await online(t, {
    config: { allow_reboot: true },
    server: { applyDelayMs: 0, failActions: true },
  });
  await ack(ctx, ctx.press(1, 'reboot'));
  await until(ctx, () => /action failed \(errored\)/.test(statusText(ctx)), 'failed', {
    step: 2000,
  });
  assert.doesNotMatch(statusText(ctx), /Reboot: done/);
});

test('an option unchecked during the read of the command takes effect at once: nothing sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.fake.latencyMs = (r) => (r.path === `/v2/droplets/${did(1)}` ? 600 : 0);
  const pressing = ctx.press(1, 'shutdown');
  await waitFor(
    () => ctx.fake.requests.some((r) => r.path === `/v2/droplets/${did(1)}`),
    'read started',
  );
  await within(
    ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_shutdown: false }),
    'config',
  );
  const res = await ack(ctx, pressing);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res), /Shut down is off/);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('an option unchecked while the periodic read runs takes effect at once', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.fake.latencyMs = (r) => (r.path === '/v2/droplets' ? 2000 : 0);
  await until(ctx, () => ctx.app.reading, 'reading', { step: 5000 });
  await within(
    ctx.gladys.fake.configUpdated({ ...ctx.raw, ...ALL_ON, allow_power_off: false }),
    'config',
    1000,
  );
  assert.equal(ctx.app.config.allowPowerOff, false);
  ctx.fake.latencyMs = 0;
  const res = await ack(ctx, ctx.press(1, 'power_off'));
  assert.match(JSON.stringify(res), /Force power off is off/);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('the option is checked again at the first byte (after the read and the guard)', async (t) => {
  const store = memoryStore();
  const ctx = await online(t, { config: ALL_ON, store });
  // The guard write is slow: the option is turned off meanwhile.
  const save = store.save.bind(store);
  store.save = async (data) => {
    if (data.stopGuards && Object.keys(data.stopGuards).length > 0) {
      ctx.app.config = { ...ctx.app.config, allowShutdown: false };
    }
    return save(data);
  };
  const res = await ack(ctx, ctx.press(1, 'shutdown'));
  assert.match(JSON.stringify(res), /Shut down is off/);
  assert.equal(ctx.fake.count('POST'), 0);
  assert.equal(ctx.app.guardLeft(did(1)), 0, 'guard withdrawn: nothing sent');
});

test('Shut down: the guard is written before sending; not written, nothing sent', async (t) => {
  const store = memoryStore();
  const ctx = await online(t, { config: ALL_ON, store });
  store.failSave = true;
  const res = await ack(ctx, ctx.press(1, 'shutdown'));
  assert.match(JSON.stringify(res), /could not keep the guard/);
  assert.equal(ctx.fake.count('POST'), 0);
  store.failSave = false;
  store.hang = true;
  const res2 = await ack(ctx, ctx.press(1, 'shutdown'), 100);
  assert.match(JSON.stringify(res2), /could not keep the guard/);
  assert.equal(ctx.fake.count('POST'), 0);
  store.hang = false;
});

test('after a shutdown, Power on of that droplet is refused for 1 min, even after a restart', async (t) => {
  const store = memoryStore();
  const ctx = await online(t, { config: ALL_ON, store });
  await ack(ctx, ctx.press(1, 'shutdown'));
  assert.ok(store.data.stopGuards[did(1)]);
  ctx.fake.droplet(1).status = 'off';
  await ctx.clock.advance(16_000);
  const res = await ack(ctx, ctx.press(1, 'power_on'));
  assert.match(JSON.stringify(res), /turned off less than a minute ago/);
  await ctx.app.shutdown();
  // Restarted: the guard comes back from /data, before any periodic read.
  const again = await setup(t, {
    config: ALL_ON,
    store,
    clock: ctx.clock,
    server: { droplets: [droplet(1, { status: 'off' })] },
  });
  const res2 = await ack(again, again.press(1, 'power_on'));
  assert.match(JSON.stringify(res2), /turned off less than a minute ago/);
  assert.equal(again.fake.count('POST'), 0);
});

test('a stop cancels a Power on of the same droplet not sent yet', async (t) => {
  const ctx = await online(t, {
    config: ALL_ON,
    server: { droplets: [droplet(1, { status: 'off' })] },
  });
  ctx.fake.latencyMs = (r) => (r.method === 'GET' && r.path === `/v2/droplets/${did(1)}` ? 500 : 0);
  const on = ctx.press(1, 'power_on');
  await waitFor(() => ctx.fake.count(`GET /v2/droplets/${did(1)}`) === 1, 'read started');
  const off = ctx.press(1, 'power_off');
  const [a, b] = await Promise.all([ack(ctx, on), ack(ctx, off)]);
  assert.match(JSON.stringify(a), /stop of this droplet came after/);
  assert.match(JSON.stringify(b), /running: nothing sent; a Power on/);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('one command per droplet per 15 s; a 422 of DigitalOcean is a refusal, nothing done', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.fake.replyFor = (r) =>
    r.method === 'POST'
      ? {
          status: 422,
          body: { id: 'unprocessable_entity', message: 'Droplet already has a pending event.' },
        }
      : undefined;
  const res = await ack(ctx, ctx.press(1, 'shutdown'));
  assert.match(JSON.stringify(res), /Refused by DigitalOcean/);
  assert.equal(ctx.app.guardLeft(did(1)), 0, 'guard withdrawn');
  const res2 = await ack(ctx, ctx.press(1, 'reboot'));
  assert.match(JSON.stringify(res2), /One command per droplet per 15 s/);
  assert.equal(ctx.fake.count('POST'), 1);
});

test('a Read token: the 403 of the action says so, nothing done, reads go on', async (t) => {
  const ctx = await online(t, { config: ALL_ON, server: { forbid: new Set(['action']) } });
  await ack(ctx, ctx.press(1, 'reboot'));
  assert.match(statusText(ctx), /without the droplet:update scope/);
  assert.equal(ctx.app.blocked, false);
});

test('sent without answer: "sent, without confirmation", never sent again; reads follow', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.fake.replyFor = (r) => (r.method === 'POST' ? 'silent' : undefined);
  const started = performance.now();
  const res = await ack(ctx, ctx.press(1, 'shutdown'), 0);
  assert.ok(performance.now() - started < 3600);
  assert.match(JSON.stringify(res), /without confirmation/);
  assert.ok(ctx.app.guardLeft(did(1)) > 0, 'the guard stays: it may have left');
  ctx.fake.replyFor = undefined;
  await until(ctx, () => ctx.fake.count(`GET /v2/droplets/${did(1)}`) >= 2, 'follow-up', {
    step: 1000,
  });
  await ctx.clock.advance(300_000);
  assert.equal(ctx.fake.count('POST'), 1);
});

test('a slow read of the droplet: too late, nothing sent', async (t) => {
  const ctx = await online(t);
  ctx.fake.droplets = [droplet(1, { status: 'off' })];
  ctx.fake.latencyMs = (r) => (r.path === `/v2/droplets/${did(1)}` ? 3000 : 0);
  const res = await ack(ctx, ctx.press(1, 'power_on'), 0);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res), /nothing sent|not be read/);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('the answer to Gladys never waits for a publication nor a status', async (t) => {
  const ctx = await online(t, {
    server: { droplets: [droplet(1, { status: 'off' }), droplet(2)] },
  });
  ctx.gladys.setConnectionStatus = () => new Promise(() => {});
  ctx.gladys.publishChangedStates = () => new Promise(() => {});
  ctx.gladys.publishTransports = () => new Promise(() => {});
  const res = await ack(ctx, ctx.press(1, 'power_on'), 0);
  assert.equal(res.success, true);
  const res2 = await ack(ctx, ctx.press(2, 'power_on'), 0);
  assert.equal(res2.success, true, 'already on: a note only');
});

test('paused (429): every command refused before anything is sent', async (t) => {
  const ctx = await online(t, { config: ALL_ON });
  ctx.app.pause({ kind: 'rate', retryAfter: 120_000 });
  const asked = ctx.fake.requests.length;
  const res = await ack(ctx, ctx.press(2, 'power_on'));
  assert.match(JSON.stringify(res), /asked to wait/);
  assert.equal(ctx.fake.requests.length, asked);
});

test('locked droplet, unknown status, a button value other than 1: refused', async (t) => {
  const ctx = await online(t, {
    server: {
      droplets: [droplet(1, { status: 'off', locked: true }), droplet(2, { status: 'weird' })],
    },
  });
  assert.match(JSON.stringify(await ack(ctx, ctx.press(1, 'power_on'))), /locked this droplet/);
  assert.match(JSON.stringify(await ack(ctx, ctx.press(2, 'power_on'))), /could not be read/);
  assert.match(JSON.stringify(await ack(ctx, ctx.press(2, 'power_on', 0))), /only takes a press/);
  assert.match(JSON.stringify(await ack(ctx, ctx.press(2, 'running', 1))), /read only/);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('a scene on 5 slow droplets powers them all on', async (t) => {
  const droplets = [1, 2, 3, 4, 5].map((n) => droplet(n, { status: 'off' }));
  const ctx = await online(t, { server: { droplets } });
  ctx.fake.latencyMs = () => 700;
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => ack(ctx, ctx.press(n, 'power_on'), 0)),
  );
  assert.ok(
    results.every((r) => r.success === true),
    JSON.stringify(results),
  );
  assert.equal(ctx.fake.count('POST'), 5);
});

test('another droplet in the answer than the one asked: nothing sent', async (t) => {
  const ctx = await online(t, {
    server: { droplets: [droplet(1, { status: 'off' }), droplet(2, { status: 'off' })] },
  });
  ctx.fake.replyFor = (r) =>
    r.method === 'GET' && r.path === `/v2/droplets/${did(1)}`
      ? { status: 200, body: { droplet: ctx.fake.droplet(2) } }
      : undefined;
  const res = await ack(ctx, ctx.press(1, 'power_on'));
  assert.equal(res.success, false);
  assert.equal(ctx.fake.count('POST'), 0);
});

test('the quota used up: commands refused before anything is sent', async (t) => {
  const ctx = await online(t);
  ctx.app.noteQuota({ limit: 5000, remaining: 2, resetIn: 600_000 }, ctx.app.config.token);
  const asked = ctx.fake.requests.length;
  const res = await ack(ctx, ctx.press(2, 'power_on'));
  assert.match(JSON.stringify(res), /quota of this token is used up/);
  assert.equal(ctx.fake.requests.length, asked);
});

test('the deadline is checked again at the first byte (a slow connection): nothing sent', async (t) => {
  const ctx = await online(t, { server: { droplets: [droplet(1, { status: 'off' })] } });
  const client = ctx.app.sessionClient();
  const send = client.action;
  // 3.45 s pass between the last check before the connection and its first byte.
  client.action = async (...args) => {
    await ctx.clock.advance(3450);
    return send(...args);
  };
  const res = await ack(ctx, ctx.press(1, 'power_on'), 0);
  assert.match(JSON.stringify(res), /answered too slowly: nothing sent/);
  assert.equal(ctx.fake.count('POST'), 0);
});
