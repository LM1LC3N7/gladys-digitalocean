// -----------------------------------------------------------------------------
// The client of the DigitalOcean API: strict parsing (unknown is never 0),
// the error envelope, the quota headers against DigitalOcean's own Date, and
// the transport (CA check, nothing written before beforeSend, answers cut
// while streaming, a frozen answer cut, no redirection followed, the token
// never in an error).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import {
  DoError,
  actionOf,
  amountOf,
  apiRequest,
  balanceOf,
  checkStateOf,
  cleanName,
  createApi,
  dropletOf,
  parseAnswer,
  quotaOf,
  retryAfterOf,
} from '../src/api.js';
import { certs } from './kit/certs.mjs';
import { TOKEN, did, droplet, fakeDo } from './helpers/fakeDo.js';
import { within } from './helpers/setup.js';

test('a droplet: strict values, unknown stays unknown', () => {
  const d = dropletOf(droplet(1));
  assert.deepEqual(d, {
    id: did(1),
    name: 'web-1',
    status: 'active',
    locked: false,
    ipv4: '203.0.113.1',
    region: 'fra1',
    size: 's-1vcpu-1gb',
  });
  const odd = dropletOf(
    droplet(3, {
      status: 'weird',
      locked: 'no',
      networks: { v4: [{ type: 'public', ip_address: '999.1.1.1' }] },
    }),
  );
  assert.equal(odd.status, undefined);
  assert.equal(odd.locked, undefined);
  assert.equal(odd.ipv4, undefined);
  assert.equal(dropletOf({ id: 0 }), undefined);
  assert.equal(dropletOf({ id: 1.5 }), undefined);
  assert.equal(dropletOf({ id: '12a' }), undefined);
  assert.equal(cleanName('a‮b\u0000c'), 'ab c');
});

test('the balance: decimal texts only; empty, null, text are unknown (never 0)', () => {
  assert.equal(amountOf('23.44'), 23.44);
  assert.equal(amountOf('-10.00'), -10);
  for (const bad of ['', ' ', null, undefined, 'N/A', '1e3', '12,5', true, NaN]) {
    assert.equal(amountOf(bad), undefined, String(bad));
  }
  const b = balanceOf({
    month_to_date_usage: '',
    month_to_date_balance: '3.10',
    account_balance: null,
    generated_at: '2026-11-27T10:00:00Z',
  });
  assert.deepEqual(b, {
    usage: undefined,
    monthBalance: 3.1,
    accountBalance: undefined,
    generatedAt: Date.parse('2026-11-27T10:00:00Z'),
  });
  assert.throws(() => balanceOf({ hello: 1 }), /not an answer of DigitalOcean/);
  assert.throws(() => balanceOf([]), DoError);
});

test('an uptime check state: down wins, up only when every region is up, uptime the lowest', () => {
  const r = (status, pct) => ({ status, thirty_day_uptime_percentage: pct });
  assert.deepEqual(checkStateOf({ state: { regions: { a: r('UP', 99.9), b: r('DOWN', 97) } } }), {
    status: 'down',
    uptime: 97,
  });
  assert.deepEqual(checkStateOf({ state: { regions: { a: r('UP', 99.9), b: r('UP', 99.95) } } }), {
    status: 'up',
    uptime: 99.9,
  });
  assert.equal(
    checkStateOf({ state: { regions: { a: r('UP'), b: r('CHECKING') } } }).status,
    'checking',
  );
  assert.deepEqual(checkStateOf({ state: { regions: {} } }), {
    status: undefined,
    uptime: undefined,
  });
  assert.equal(checkStateOf({ state: { regions: { a: r('UP', 140) } } }).uptime, undefined);
  assert.throws(() => checkStateOf({}), DoError);
});

test('an action: its id, status and droplet', () => {
  assert.deepEqual(
    actionOf({ action: { id: 5, status: 'completed', type: 'reboot', resource_id: 300000001 } }),
    {
      id: 5,
      status: 'completed',
      type: 'reboot',
      resourceId: did(1),
    },
  );
  assert.throws(() => actionOf({ action: { id: '5' } }), DoError);
});

test('the error envelope: 401 in it is "unauth" with envelope; a proxy 401 is not', () => {
  const e1 = assert.throws(
    () =>
      parseAnswer({
        status: 401,
        body: '{"id":"unauthorized","message":"Unable to authenticate you"}',
      }),
    (e) => e.kind === 'unauth' && e.envelope === true,
  );
  assert.equal(e1, undefined);
  assert.throws(
    () => parseAnswer({ status: 401, body: '<html>401</html>' }),
    (e) => e.kind === 'unauth' && e.envelope === false,
  );
  assert.throws(
    () => parseAnswer({ status: 302, body: '' }),
    (e) => e.kind === 'redirect',
  );
  assert.throws(
    () => parseAnswer({ status: 403, body: '' }),
    (e) => e.kind === 'forbidden',
  );
  assert.throws(
    () =>
      parseAnswer(
        {
          status: 422,
          body: JSON.stringify({ id: 'unprocessable_entity', message: `bad ${TOKEN}` }),
        },
        { secrets: [TOKEN] },
      ),
    (e) => e.kind === 'refused' && !e.message.includes(TOKEN) && e.message.includes('***'),
  );
});

test('quota headers: reset read against the Date of DigitalOcean, never the local clock', () => {
  const date = 'Fri, 27 Nov 2026 10:00:00 GMT';
  const reset = Date.parse(date) / 1000 + 120;
  assert.deepEqual(
    quotaOf({
      'ratelimit-limit': '5000',
      'ratelimit-remaining': '12',
      'ratelimit-reset': String(reset),
      date,
    }),
    { limit: 5000, remaining: 12, resetIn: 120_000 },
  );
  assert.equal(
    quotaOf({
      'ratelimit-limit': '5000',
      'ratelimit-remaining': '12',
      'ratelimit-reset': String(reset),
    }).resetIn,
    undefined,
    'no Date: unknown',
  );
  assert.equal(quotaOf({ 'ratelimit-remaining': '-3' }), undefined);
  assert.equal(retryAfterOf('29'), 29_000);
  assert.equal(retryAfterOf('Fri, 27 Nov 2026 10:01:00 GMT', date), 60_000);
  assert.equal(retryAfterOf('Fri, 27 Nov 2026 10:01:00 GMT'), undefined);
});

/** A bare HTTPS server for transport tests. */
async function server(t, handler) {
  const srv = createServer({ key: certs.device.key, cert: certs.device.cert }, handler);
  const sockets = new Set();
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  srv.on('tlsClientError', () => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(() => r()));
  });
  return {
    host: '127.0.0.1',
    port: srv.address().port,
    servername: 'device',
    ca: certs.device.cert,
  };
}

test('the CA check: another certificate is refused before anything is written', async (t) => {
  let got = 0;
  const origin = await server(t, (req, res) => {
    got += 1;
    res.end('{}');
  });
  const err = await within(
    apiRequest({
      origin: { ...origin, ca: certs.impostor.cert },
      method: 'GET',
      path: '/v2/droplets',
      token: TOKEN,
    }).catch((e) => e),
    'request',
  );
  assert.equal(err.kind, 'tls');
  assert.equal(err.sent, false);
  assert.equal(got, 0);
});

test('beforeSend runs once the connection is up; throwing there sends nothing', async (t) => {
  let got = 0;
  const origin = await server(t, (req, res) => {
    got += 1;
    res.end('{}');
  });
  const err = await within(
    apiRequest({
      origin,
      method: 'POST',
      path: '/v2/droplets/1/actions',
      token: TOKEN,
      json: { type: 'power_on' },
      beforeSend: () => {
        throw new Error('option off');
      },
    }).catch((e) => e),
    'request',
  );
  assert.equal(err.message, 'option off');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got, 0);
});

test('an answer too large is cut while it streams; a frozen answer is cut', async (t) => {
  const origin = await server(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/big') {
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(chunk);
      res.end();
    } else {
      res.write('{"droplets":[');
    }
  });
  const big = await within(
    apiRequest({ origin, method: 'GET', path: '/big', maxBytes: 100_000 }).catch((e) => e),
    'big',
  );
  assert.equal(big.kind, 'size');
  const started = performance.now();
  const frozen = await within(
    apiRequest({ origin, method: 'GET', path: '/frozen', idleTimeout: 300, timeout: 5000 }).catch(
      (e) => e,
    ),
    'frozen',
  );
  assert.equal(frozen.kind, 'timeout');
  assert.ok(performance.now() - started < 2000);
});

test('a redirection is never followed; the token never in an error', async (t) => {
  const seen = [];
  const origin = await server(t, (req, res) => {
    seen.push(req.url);
    res.writeHead(301, { location: 'https://evil.example/' });
    res.end();
  });
  const api = createApi({ token: TOKEN, origin });
  t.after(() => api.close());
  const err = await within(
    api.droplets().catch((e) => e),
    'droplets',
  );
  assert.equal(err.kind, 'redirect');
  assert.deepEqual(seen, ['/v2/droplets?page=1&per_page=200']);
  assert.ok(!JSON.stringify({ m: err.message, ...err }).includes(TOKEN));
});

test('the droplet list: pages by number, at most 5; overflow said', async (t) => {
  const fake = await fakeDo({ droplets: Array.from({ length: 1001 }, (_, i) => droplet(i + 1)) });
  t.after(() => fake.close());
  const api = createApi({ token: TOKEN, origin: fake.origin });
  t.after(() => api.close());
  const list = await within(api.droplets(), 'droplets', 15_000);
  assert.equal(list.items.length, 1000);
  assert.equal(list.overflow, true);
  assert.equal(fake.count('GET /v2/droplets'), 5);
  assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
  assert.match(
    fake.requests[0].headers['user-agent'],
    /^gladys-digitalocean\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-digitalocean\)$/,
  );
});

test('only the four action types can be sent; a wrong answer is not the action asked', async (t) => {
  const fake = await fakeDo();
  t.after(() => fake.close());
  const api = createApi({ token: TOKEN, origin: fake.origin });
  t.after(() => api.close());
  for (const type of [
    'resize',
    'rebuild',
    'restore',
    'snapshot',
    'password_reset',
    'power_cycle',
  ]) {
    await assert.rejects(api.action(did(1), type), /action not allowed/);
  }
  assert.equal(fake.count('POST'), 0);
  const a = await within(api.action(did(1), 'reboot'), 'reboot');
  assert.equal(a.type, 'reboot');
  assert.deepEqual(JSON.parse(fake.requests.at(-1).body), { type: 'reboot' });
});

test('the alert policies: only the count of enabled ones (no e-mail, no Slack URL kept)', async (t) => {
  const fake = await fakeDo();
  t.after(() => fake.close());
  const api = createApi({ token: TOKEN, origin: fake.origin });
  t.after(() => api.close());
  const alerts = await within(api.alerts(), 'alerts');
  assert.deepEqual(alerts, { enabled: 1 });
});

test('no answer at all: cut by the idle delay, not the whole timeout', async (t) => {
  const origin = await server(t, () => {});
  const started = performance.now();
  const err = await within(
    apiRequest({ origin, method: 'GET', path: '/x', idleTimeout: 300, timeout: 5000 }).catch(
      (e) => e,
    ),
    'silent',
  );
  assert.equal(err.kind, 'timeout');
  assert.equal(err.sent, true);
  assert.ok(performance.now() - started < 2000);
});

test('an action answered for another type or droplet is not the action asked', async (t) => {
  const fake = await fakeDo({
    replyFor: (r) =>
      r.method === 'POST'
        ? {
            status: 201,
            body: {
              action: { id: 9, status: 'in-progress', type: 'power_cycle', resource_id: 300000001 },
            },
          }
        : undefined,
  });
  t.after(() => fake.close());
  const api = createApi({ token: TOKEN, origin: fake.origin });
  t.after(() => api.close());
  await assert.rejects(within(api.action(did(1), 'reboot'), 'action'), /not the action asked/);
});
