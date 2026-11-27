// -----------------------------------------------------------------------------
// Reads, Discovery, states, refusal of the token, pauses, quota, /data and the
// lifecycle, against the simulated DigitalOcean over HTTPS on 127.0.0.1 and
// the SDK's fake Gladys (virtual timers, real network, bounded waits).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, tokenMark } from '../src/store.js';
import {
  ACCOUNT_UUID,
  OTHER_TOKEN,
  RFC_TEAM_UUID,
  TEAM_UUID,
  TOKEN,
  cid,
  did,
  droplet,
} from './helpers/fakeDo.js';
import {
  ack,
  created,
  idle,
  online,
  setup,
  stateOf,
  statusText,
  until,
  waitFor,
  within,
} from './helpers/setup.js';

test('first read: Discovery of the account, droplets and checks; states of the created features', async (t) => {
  const ctx = await online(t);
  const discovered = ctx.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(discovered, [
    `ext:test-integration:do-account:${TEAM_UUID}`,
    `ext:test-integration:do-droplet:${did(1)}`,
    `ext:test-integration:do-droplet:${did(2)}`,
    `ext:test-integration:do-uptime:${cid(1)}`,
  ]);
  assert.equal(stateOf(ctx, 'droplet', did(1), 'running'), 1);
  assert.equal(stateOf(ctx, 'droplet', did(2), 'running'), 0);
  assert.equal(stateOf(ctx, 'droplet', did(1), 'status'), 'Running');
  assert.equal(stateOf(ctx, 'droplet', did(1), 'public_ipv4'), '203.0.113.1');
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'month_usage'), 11.21);
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'month_balance'), 23.44);
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'account_balance'), 12.23);
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'alert_policies'), 1);
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'account_status'), 'Active');
  assert.equal(stateOf(ctx, 'check', cid(1), 'up'), 1);
  assert.equal(stateOf(ctx, 'check', cid(1), 'uptime_30d'), 99.9);
  assert.match(statusText(ctx), /Connected: 2 droplet\(s\) \(1 running\), 1 uptime check/);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('unknown values are never published as 0', async (t) => {
  const ctx = await online(t, {
    server: {
      droplets: [droplet(1, { status: 'new', networks: { v4: [] } })],
      balance: {
        month_to_date_usage: '',
        month_to_date_balance: null,
        account_balance: 'N/A',
        generatedAgoMs: 0,
      },
      states: { [cid(1)]: { regions: { us_east: { status: 'CHECKING' } } } },
    },
  });
  for (const key of ['running', 'public_ipv4']) {
    assert.equal(stateOf(ctx, 'droplet', did(1), key), undefined, key);
  }
  assert.equal(stateOf(ctx, 'droplet', did(1), 'status'), 'Being created');
  for (const key of ['month_usage', 'month_balance', 'account_balance']) {
    assert.equal(stateOf(ctx, 'account', TEAM_UUID, key), undefined, key);
  }
  assert.equal(stateOf(ctx, 'check', cid(1), 'up'), undefined);
  assert.equal(stateOf(ctx, 'check', cid(1), 'uptime_30d'), undefined);
  assert.equal(stateOf(ctx, 'check', cid(1), 'check_status'), 'Checking');
});

test('a balance generated more than 48 h ago (Date of DigitalOcean) is not published', async (t) => {
  const ctx = await online(t, {
    server: { balance: { month_to_date_usage: '5.00', generatedAgoMs: 49 * 3_600_000 } },
  });
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'month_usage'), undefined);
});

test('the reads come at the interval, never sooner; the balance once an hour', async (t) => {
  const ctx = await online(t, { config: { poll_interval: 120 } });
  assert.equal(ctx.fake.count('GET /v2/droplets'), 1);
  await ctx.clock.advance(119_000);
  await idle(ctx);
  assert.equal(ctx.fake.count('GET /v2/droplets'), 1);
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 2, 'second read', { step: 500 });
  await idle(ctx);
  assert.equal(ctx.fake.count('/v2/customers/my/balance'), 1);
  assert.equal(ctx.fake.count('/v2/account'), 1);
  assert.equal(ctx.fake.count('/state'), 2, 'uptime states each cycle');
  // The Scan button reads nothing sooner than the interval.
  await within(ctx.gladys.fake.scanRequest(), 'scan');
  assert.equal(ctx.fake.count('GET /v2/droplets'), 2);
});

test('a restart reads no sooner than the interval after the last read (/data)', async (t) => {
  const store = memoryStore();
  const first = await online(t, { store });
  assert.ok(store.data.lastReadAt > 0);
  await first.app.shutdown();
  const second = await setup(t, { store, clock: first.clock });
  await second.clock.advance(1000);
  await idle(second);
  assert.equal(second.fake.count('GET /v2/droplets'), 0);
  await until(
    second,
    () => second.fake.count('GET /v2/droplets') === 1,
    'read after the interval',
    {
      step: 5000,
    },
  );
});

test('401 in the envelope on the droplet list: refused, kept in /data, never tried alone', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: { token: 'dop_v1_' + 'a'.repeat(64) } });
  await until(ctx, () => ctx.app.blocked, 'refused');
  assert.match(statusText(ctx), /refused the token/);
  assert.ok(store.data.refused && Number.isInteger(store.data.refused.mark));
  assert.ok(!JSON.stringify(store.data).includes('a'.repeat(64)));
  await ctx.clock.advance(3_600_000);
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.fake.count('GET /v2/droplets'), 1);
  // A restart keeps it.
  await ctx.app.shutdown();
  const again = await setup(t, { store, config: { token: 'dop_v1_' + 'a'.repeat(64) } });
  await again.clock.advance(300_000);
  await waitFor(() => again.app.blocked, 'still refused');
  assert.equal(again.fake.count('GET /v2/droplets'), 0);
  // The Test button tries again (refused again: still blocked).
  const res = await within(again.gladys.fake.action('test_connection'), 'test');
  assert.match(JSON.stringify(res), /refused the token/);
  assert.equal(again.fake.count('GET /v2/droplets'), 1);
  // Another token saved: read at once.
  await within(again.gladys.fake.configUpdated({ ...again.raw, token: TOKEN }), 'config');
  await until(again, () => again.app.online, 'online with the new token');
  assert.equal(again.store.data.refused, null);
});

test('the Test button lifts a refusal when the token is accepted again', async (t) => {
  const ctx = await setup(t, { config: { token: OTHER_TOKEN } });
  ctx.fake.tokens.delete(OTHER_TOKEN);
  await until(ctx, () => ctx.app.blocked, 'refused');
  ctx.fake.tokens.add(OTHER_TOKEN);
  const res = await within(ctx.gladys.fake.action('test_connection'), 'test');
  assert.match(JSON.stringify(res), /token accepted: 2 droplet/);
  await until(ctx, () => ctx.app.online && !ctx.app.blocked, 'online again');
  assert.equal(ctx.store.data.refused, null);
});

test('a 401 without the envelope (a proxy) or on a secondary route is never a refusal', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        r.path === '/v2/droplets' ? { status: 401, body: '<html>proxy</html>' } : undefined,
    },
  });
  await until(ctx, () => ctx.app.lastError, 'failed read');
  assert.equal(ctx.app.blocked, false);
  assert.equal(ctx.store.data?.refused ?? null, null);
  // Secondary 401/403: the droplets are still read and published.
  const two = await online(t, {
    server: {
      forbid: new Set(['balance', 'alerts']),
      replyFor: (r) =>
        r.path === '/v2/account'
          ? { status: 401, body: { id: 'unauthorized', message: 'no' } }
          : undefined,
    },
  });
  assert.equal(two.app.blocked, false);
  assert.equal(stateOf(two, 'droplet', did(1), 'running'), 1);
  assert.match(statusText(two), /Not read: account, balance \(billing:read\), alert policies/);
  // Spaced: not asked again at the next cycle.
  await until(two, () => two.fake.count('GET /v2/droplets') === 2, 'next read', { step: 5000 });
  await idle(two);
  assert.equal(two.fake.count('/v2/customers/my/balance'), 1);
});

test('a 429 pauses every path with Retry-After (bounded, kept in /data)', async (t) => {
  let limited = true;
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        limited && r.path === '/v2/droplets'
          ? {
              status: 429,
              body: { id: 'too_many_requests', message: 'API Rate limit exceeded.' },
              headers: { 'retry-after': '600' },
            }
          : undefined,
    },
  });
  await until(ctx, () => ctx.app.paused(), 'paused');
  limited = false;
  assert.ok(ctx.store.data.pausedUntil > ctx.clock.now() + 590_000);
  assert.match(statusText(ctx), /asked to wait/);
  await ctx.clock.advance(590_000);
  await idle(ctx);
  assert.equal(ctx.fake.count('GET /v2/droplets'), 1);
  await until(ctx, () => ctx.app.online, 'read after the pause', { step: 5000 });
  // An absurd Retry-After is bounded to 6 h.
  const two = await setup(t, {
    server: { replyFor: () => ({ status: 429, body: {}, headers: { 'retry-after': '99999999' } }) },
  });
  await until(two, () => two.app.paused(), 'paused');
  assert.ok(two.app.pauseLeft() <= 6 * 3_600_000);
});

test('a 5xx pauses and the pause grows with repeated failures', async (t) => {
  const ctx = await setup(t, { server: { replyFor: () => ({ status: 503, body: 'down' }) } });
  await until(ctx, () => ctx.app.paused(), 'paused');
  const first = ctx.app.pauseLeft();
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 2, 'second try', { step: 10_000 });
  await until(ctx, () => ctx.app.paused(), 'paused again');
  assert.ok(ctx.app.pauseLeft() > first * 1.5, `${ctx.app.pauseLeft()} > ${first}`);
});

test('quota: under 20 % left only the droplets are read; under 25 the reads wait', async (t) => {
  const ctx = await online(t, { server: { quota: { limit: 5000, remaining: 900 } } });
  assert.equal(ctx.fake.count('/v2/customers/my/balance'), 0);
  assert.equal(ctx.fake.count('/v2/uptime'), 0);
  assert.match(statusText(ctx), /Less than 20 %/);
  ctx.fake.quota.remaining = 20;
  ctx.fake.quota.resetInS = 900;
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 2, 'next read', { step: 5000 });
  await idle(ctx);
  assert.match(statusText(ctx), /quota of this token is nearly used/);
  await ctx.clock.advance(600_000);
  await idle(ctx);
  assert.equal(ctx.fake.count('GET /v2/droplets'), 2, 'waits for the reset');
  ctx.fake.quota.remaining = 4000;
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 3, 'read after the reset', {
    step: 10_000,
  });
});

test('getConfig() failing in connected: tried again, spaced, the status says so; then reads', async (t) => {
  let fail = 0;
  const ctx = await setup(t, {
    getConfig: async () => {
      if (fail > 0) {
        fail -= 1;
        throw new Error('gladys busy');
      }
      return ctx.raw;
    },
    connect: false,
  });
  await within(ctx.gladys.connect(), 'connect');
  await until(ctx, () => ctx.app.online, 'online');
  // A reconnection (the handler of 'connected') whose getConfig fails twice.
  fail = 2;
  await within(
    ctx.app.connectedWith(() => ctx.gladys.getConfig()),
    'connected',
  );
  assert.match(statusText(ctx), /did not give the configuration: tried again in 5 s/);
  await ctx.clock.advance(5000);
  await until(ctx, () => /tried again in 15 s/.test(statusText(ctx)), 'second failure');
  await until(ctx, () => /Connected/.test(statusText(ctx)), 'back', { step: 5000 });
  assert.equal(fail, 0);
});

test('/data unreadable: the start goes on, read again every 10 s, nothing written over it', async (t) => {
  const store = memoryStore({ lastReadAt: 1 });
  store.failLoad = true;
  const ctx = await online(t, { store });
  assert.equal(ctx.app.memoryState, 'unreadable');
  assert.match(statusText(ctx), /\/data is unreadable/);
  assert.equal(store.saves, 0);
  store.failLoad = false;
  await until(ctx, () => ctx.app.memoryState === 'loaded', 'read again', { step: 2000 });
});

test('/data hanging never holds the start', async (t) => {
  const store = memoryStore();
  store.hangLoad = true;
  const ctx = await setup(t, { store, connect: false });
  const connecting = ctx.gladys.connect();
  await until(ctx, () => ctx.app.online, 'online', { step: 500 });
  await within(connecting, 'connect');
  assert.equal(ctx.app.memoryState, 'unreadable');
});

test('another token: what was read with the old one is dropped', async (t) => {
  const ctx = await online(t);
  assert.ok(ctx.app.account);
  ctx.fake.replyFor = (r) => (r.path === '/v2/account' ? { status: 500, body: '' } : undefined);
  await within(ctx.gladys.fake.configUpdated({ ...ctx.raw, token: OTHER_TOKEN }), 'config');
  assert.equal(ctx.app.account, undefined);
  assert.equal(ctx.app.balance, undefined);
});

test('a device created later gets the recent values only', async (t) => {
  const ctx = await online(t, { devices: [] });
  assert.equal(ctx.gladys.fake.states.length, 0);
  await within(ctx.gladys.fake.deviceCreated(created('droplet', did(1))), 'created');
  await waitFor(() => stateOf(ctx, 'droplet', did(1), 'running') === 1, 'published');
});

test('the token is never in the logs, the status nor /data', async (t) => {
  const ctx = await online(t);
  await setup(t, { config: { token: 'dop_v1_' + 'b'.repeat(64) } });
  const all = JSON.stringify([ctx.logs, ctx.gladys.fake.connectionStatuses, ctx.store.data]);
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes('b'.repeat(64)));
  assert.ok(!all.includes('person@example.com'), 'no e-mail');
  assert.ok(!all.includes('hooks.slack.com'), 'no Slack URL');
});

test('stop() leaves no timer: no request after shutdown', async (t) => {
  const ctx = await online(t);
  await ctx.app.shutdown();
  const asked = ctx.fake.requests.length;
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.fake.requests.length, asked);
  assert.equal(ctx.clock.pending, 0);
});

test('a failed read: no stale droplet value later, only what a command read again', async (t) => {
  const ctx = await online(t, { devices: [created('droplet', did(2))] });
  ctx.fake.replyFor = (r) =>
    r.path === '/v2/droplets'
      ? { status: 400, body: { id: 'bad_request', message: 'x' } }
      : undefined;
  await until(ctx, () => ctx.app.lastError, 'failed read', { step: 5000 });
  await ctx.clock.advance(200_000);
  await within(ctx.gladys.fake.deviceCreated(created('droplet', did(1))), 'created');
  ctx.fake.droplet(2).status = 'off';
  // A command reads droplet 2 again: its fresh value is sent, never droplet 1's old one.
  await ack(ctx, ctx.press(2, 'power_on'));
  await until(ctx, () => stateOf(ctx, 'droplet', did(2), 'running') === 1, 'droplet 2 published', {
    step: 1000,
  });
  assert.equal(stateOf(ctx, 'droplet', did(1), 'running'), undefined);
});

test('a refused token holds the commands: nothing read nor sent', async (t) => {
  const ctx = await setup(t, { config: { token: OTHER_TOKEN } });
  ctx.fake.tokens.delete(OTHER_TOKEN);
  await until(ctx, () => ctx.app.blocked, 'refused');
  const asked = ctx.fake.requests.length;
  const res = await ack(ctx, ctx.press(2, 'power_on'));
  assert.match(JSON.stringify(res), /refused the token: nothing sent/);
  assert.equal(ctx.fake.requests.length, asked);
});

test('a configuration saved while getConfig() runs wins over its older answer', async (t) => {
  const waiting = [];
  const ctx = await setup(t, {
    getConfig: () => new Promise((r) => waiting.push(r)),
    connect: false,
  });
  const connecting = ctx.gladys.connect();
  // The SDK's own read at connect, then the app's (the handler of 'connected').
  await waitFor(() => waiting.length === 1, 'connect asked');
  waiting[0]({ ...ctx.raw, allow_shutdown: true });
  await waitFor(() => waiting.length === 2, 'the app asked');
  await within(ctx.gladys.fake.configUpdated({ ...ctx.raw, allow_shutdown: false }), 'saved');
  waiting[1]({ ...ctx.raw, allow_shutdown: true });
  await within(connecting, 'connect');
  await until(ctx, () => ctx.app.online, 'online');
  assert.equal(ctx.app.config.allowShutdown, false);
});

test('a 5xx on a secondary read pauses every path too', async (t) => {
  const ctx = await setup(t, {
    server: {
      replyFor: (r) =>
        r.path === '/v2/customers/my/balance' ? { status: 502, body: 'bad gateway' } : undefined,
    },
  });
  await until(ctx, () => ctx.app.paused(), 'paused');
  assert.equal(ctx.fake.count('/v2/monitoring/alerts'), 0, 'the next secondary reads wait');
});

// --- Review r1 -------------------------------------------------------------------

const accountDevice = (ctx) =>
  ctx.gladys.fake.discoveredDevices.find((d) => d.external_id.includes(':do-account:'))
    ?.external_id;

test('the account ids of the OpenAPI: 40 characters without a team, a team in RFC form, both taken', async (t) => {
  const solo = await online(t, { server: { account: { uuid: ACCOUNT_UUID, status: 'active' } } });
  assert.equal(accountDevice(solo), `ext:test-integration:do-account:${ACCOUNT_UUID}`);
  const team = await online(t, {
    server: {
      account: { uuid: ACCOUNT_UUID, status: 'active', team: { uuid: RFC_TEAM_UUID, name: 'T' } },
    },
  });
  assert.equal(accountDevice(team), `ext:test-integration:do-account:${RFC_TEAM_UUID}`);
  const official = await online(t);
  assert.equal(accountDevice(official), `ext:test-integration:do-account:${TEAM_UUID}`);
  assert.equal(stateOf(official, 'account', TEAM_UUID, 'month_usage'), 11.21);
  // An id unsafe in an external id is refused (no device, said in the status).
  const bad = await online(t, { server: { account: { uuid: 'a:b/../c', status: 'active' } } });
  assert.equal(accountDevice(bad), undefined);
  assert.match(statusText(bad), /Not read: account/);
});

test('a refusal kept in /data read late (first unreadable) stops the reads once read', async (t) => {
  const salt = '0123456789abcdef';
  const store = memoryStore({ refused: { salt, mark: tokenMark(salt, TOKEN) } });
  store.failLoad = true;
  const ctx = await online(t, { store });
  assert.equal(ctx.app.blocked, false);
  store.failLoad = false;
  await until(ctx, () => ctx.app.blocked, 'refusal adopted', { step: 2000 });
  const asked = ctx.fake.count('GET /v2/droplets');
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.fake.count('GET /v2/droplets'), asked);
});

test('the Test button: a 401 without the envelope is not a refusal; never sooner than the interval', async (t) => {
  const ctx = await online(t);
  const asked = ctx.fake.count('GET /v2/droplets');
  const res = await within(ctx.gladys.fake.action('test_connection'), 'test');
  assert.match(JSON.stringify(res), /next read in/);
  assert.equal(ctx.fake.count('GET /v2/droplets'), asked);
  await ctx.clock.advance(130_000);
  await idle(ctx);
  ctx.fake.replyFor = (r) =>
    r.path === '/v2/droplets' ? { status: 401, body: '<html>proxy</html>' } : undefined;
  await ctx.clock.advance(130_000);
  await idle(ctx);
  ctx.app.lastReadMono = -Infinity;
  ctx.app.lastTest = undefined;
  const before = ctx.fake.count('GET /v2/droplets');
  await within(ctx.gladys.fake.action('test_connection'), 'test 2');
  assert.equal(ctx.fake.count('GET /v2/droplets'), before + 1, 'the Test button read');
  assert.equal(ctx.app.blocked, false);
  assert.equal(ctx.store.data?.refused ?? null, null);
});

test('alert policies and uptime states no longer read are not sent again as new', async (t) => {
  const ctx = await online(t, { devices: [] });
  ctx.fake.forbid.add('alerts');
  ctx.fake.forbid.add('state');
  // More than 2 h of reads: both are stale.
  await until(ctx, () => ctx.clock.elapsed > 3 * 3_600_000, 'time', {
    step: 60_000,
    timeout: 15_000,
  });
  await within(ctx.gladys.fake.deviceCreated(created('account', TEAM_UUID)), 'account');
  await within(ctx.gladys.fake.deviceCreated(created('check', cid(1))), 'check');
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'alert_policies'), undefined);
  assert.equal(stateOf(ctx, 'check', cid(1), 'up'), undefined);
  assert.equal(
    stateOf(ctx, 'account', TEAM_UUID, 'month_usage'),
    11.21,
    'the balance is still fresh',
  );
});

test('at most 240 states a minute to Gladys; the rest at the next reads', async (t) => {
  const droplets = Array.from({ length: 150 }, (_, i) => droplet(i + 1));
  const devices = droplets.map((d) => created('droplet', String(d.id)));
  const ctx = await online(t, { devices, server: { droplets } });
  assert.equal(ctx.gladys.fake.states.length, 240);
  await until(ctx, () => ctx.gladys.fake.states.length === 450, 'the rest', { step: 10_000 });
});

test('another account behind the token: its old balance and alerts go', async (t) => {
  const ctx = await online(t);
  assert.ok(ctx.app.balance);
  ctx.fake.account = { uuid: ACCOUNT_UUID, status: 'active' };
  ctx.fake.forbid.add('balance');
  ctx.fake.forbid.add('alerts');
  await until(ctx, () => ctx.app.account?.id === ACCOUNT_UUID, 'account read again', {
    step: 60_000,
    timeout: 15_000,
  });
  assert.equal(ctx.app.balance, undefined);
  assert.equal(ctx.app.alerts, undefined);
});

test('a reconnection with the same configuration sends the fresh values again', async (t) => {
  const ctx = await online(t);
  const before = ctx.gladys.fake.states.length;
  await within(
    ctx.app.connectedWith(() => ctx.gladys.getConfig()),
    'connected',
  );
  assert.ok(ctx.gladys.fake.states.length > before);
});

// --- Review r2 -------------------------------------------------------------------

test('Scan during the back-off of failed reads never shortens it', async (t) => {
  const ctx = await setup(t, {
    config: { poll_interval: 60 },
    server: {
      replyFor: (r) =>
        r.path === '/v2/droplets'
          ? { status: 404, body: { id: 'not_found', message: 'x' } }
          : undefined,
    },
  });
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 2, 'two failed reads', {
    step: 5000,
  });
  await idle(ctx);
  // Back-off after the 2nd failure: 120 s (twice the interval).
  await ctx.clock.advance(10_000);
  await within(ctx.gladys.fake.scanRequest(), 'scan');
  await ctx.clock.advance(70_000);
  await idle(ctx);
  assert.equal(ctx.fake.count('GET /v2/droplets'), 2, 'not at the interval: the back-off holds');
  await until(ctx, () => ctx.fake.count('GET /v2/droplets') === 3, 'third read', { step: 5000 });
});

test('the account status is not sent as new once older than 12 h', async (t) => {
  const ctx = await online(t, { devices: [], config: { poll_interval: 3600 } });
  ctx.fake.forbid.add('account');
  await until(ctx, () => ctx.clock.elapsed > 13 * 3_600_000, 'time', {
    step: 600_000,
    timeout: 15_000,
  });
  await idle(ctx);
  await within(ctx.gladys.fake.deviceCreated(created('account', TEAM_UUID)), 'account');
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'account_status'), undefined);
  assert.equal(stateOf(ctx, 'account', TEAM_UUID, 'month_usage'), 11.21, 'the balance is fresh');
});
