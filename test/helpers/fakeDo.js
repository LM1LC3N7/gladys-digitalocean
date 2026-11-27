// -----------------------------------------------------------------------------
// A simulated DigitalOcean API v2, written from its official documentation
// (docs.digitalocean.com/reference/api, OpenAPI github.com/digitalocean/openapi):
// envelopes, pagination (`links.pages.next`, `meta.total`), the error
// envelope `{ id, message }`, the quota headers (ratelimit-limit, -remaining,
// -reset) on every answer, `retry-after` on a 429. Real HTTPS on 127.0.0.1
// with the kit's self-signed certificate (the client trusts it as its CA,
// with the name `device`). Every request is recorded (method, path, query,
// headers, body); answers can be replaced per request (`replyFor`), delayed
// (`latencyMs`) or held (`silent`). Droplet actions apply after
// `applyDelayMs`. No real account was used.
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { certs } from '../kit/certs.mjs';

export const TOKEN = `dop_v1_${'0123456789abcdef'.repeat(4)}`;
export const OTHER_TOKEN = `dop_v1_${'fedcba9876543210'.repeat(4)}`;
export const ACCOUNT_UUID = '4f7a1b52-2c1e-4d8e-9b0a-6c3d2e1f0a9b';
export const TEAM_UUID = '5df3e300-4a6f-4b9c-9e0f-8a7b6c5d4e3f';

/** The id of droplet n. */
export const did = (n) => String(300_000_000 + n);
export const cid = (n) => `0000000${n}`.slice(-8) + '-9653-4bd1-bef5-d6bff52042e4';

export const droplet = (n, extra = {}) => ({
  id: 300_000_000 + n,
  name: `web-${n}`,
  memory: 1024,
  vcpus: 1,
  disk: 25,
  locked: false,
  status: 'active',
  kernel: null,
  created_at: '2026-01-10T10:00:00Z',
  features: ['monitoring'],
  backup_ids: [],
  next_backup_window: null,
  snapshot_ids: [],
  image: {
    id: 1,
    name: 'Ubuntu 24.04 (LTS) x64',
    distribution: 'Ubuntu',
    slug: 'ubuntu-24-04-x64',
  },
  volume_ids: [],
  size: { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, price_monthly: 6 },
  size_slug: 's-1vcpu-1gb',
  networks: {
    v4: [
      { ip_address: '10.110.0.2', netmask: '255.255.240.0', gateway: '', type: 'private' },
      {
        ip_address: `203.0.113.${n}`,
        netmask: '255.255.240.0',
        gateway: '203.0.113.1',
        type: 'public',
      },
    ],
    v6: [],
  },
  region: { name: 'Frankfurt 1', slug: 'fra1', features: [], available: true, sizes: [] },
  tags: [],
  vpc_uuid: '760e09ef-dc84-11e8-981e-3cfdfeaae000',
  ...extra,
});

const error = (status, id, message) => ({ status, body: { id, message } });
const unauthorized = error(401, 'unauthorized', 'Unable to authenticate you');
const forbidden = error(403, 'forbidden', 'You are not authorized to perform this operation');

export async function fakeDo(options = {}) {
  const sockets = new Set();
  const timers = new Set();
  let nextAction = 1_000_000;
  const fake = {
    droplets: [droplet(1), droplet(2, { status: 'off' })],
    account: {
      droplet_limit: 25,
      floating_ip_limit: 3,
      email: 'person@example.com',
      name: 'Person',
      uuid: ACCOUNT_UUID,
      email_verified: true,
      status: 'active',
      status_message: '',
      team: { uuid: TEAM_UUID, name: 'My Team' },
    },
    balance: {
      month_to_date_balance: '23.44',
      account_balance: '12.23',
      month_to_date_usage: '11.21',
      generatedAgoMs: 3_600_000,
    },
    policies: [
      {
        uuid: '78b3da62-27e5-49ba-ac70-5db0b5935c64',
        type: 'v1/insights/droplet/cpu',
        description: 'CPU Alert',
        compare: 'GreaterThan',
        value: 80,
        window: '5m',
        entities: ['300000001'],
        tags: [],
        alerts: {
          email: ['person@example.com'],
          slack: [
            { channel: 'ops', url: 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX' },
          ],
        },
        enabled: true,
      },
      {
        uuid: '78b3da62-27e5-49ba-ac70-5db0b5935c65',
        type: 'v1/insights/droplet/memory_utilization_percent',
        description: 'RAM',
        compare: 'GreaterThan',
        value: 90,
        window: '10m',
        entities: [],
        tags: ['prod'],
        alerts: { email: [], slack: [] },
        enabled: false,
      },
    ],
    checks: [
      {
        id: cid(1),
        name: 'Landing page',
        type: 'https',
        target: 'https://www.example.com',
        regions: ['us_east', 'eu_west'],
        enabled: true,
      },
    ],
    /** check id -> { regions: { us_east: { status, thirty_day_uptime_percentage } } } */
    states: {},
    /** names refused with a 403 (scope missing): 'droplets', 'account', 'balance', 'alerts', 'checks', 'state', 'action' */
    forbid: new Set(),
    tokens: new Set([TOKEN, OTHER_TOKEN]),
    dateOffset: 0,
    applyDelayMs: 0,
    latencyMs: 0,
    quota: { limit: 5000, remaining: 4800 },
    /** (request) => { status, body, headers } | 'silent' | 'drop' | undefined */
    replyFor: undefined,
    requests: [],
    actions: [],
    ...options,
    serverNow() {
      return Date.now() + this.dateOffset;
    },
    count(match) {
      return this.requests.filter((r) => `${r.method} ${r.path}`.includes(match)).length;
    },
    droplet(n) {
      return this.droplets.find((d) => d.id === 300_000_000 + n);
    },
  };

  const authorized = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return Boolean(m && fake.tokens.has(m[1]));
  };

  const page = (r, key, items) => {
    const per = Math.min(200, Math.max(1, Number(r.query.per_page ?? 20) || 20));
    const n = Math.max(1, Number(r.query.page ?? 1) || 1);
    const slice = items.slice((n - 1) * per, n * per);
    const pages = {};
    if (n * per < items.length) {
      pages.next = `https://api.digitalocean.com${r.path}?page=${n + 1}&per_page=${per}`;
      pages.last = `https://api.digitalocean.com${r.path}?page=${Math.ceil(items.length / per)}&per_page=${per}`;
    }
    return { status: 200, body: { [key]: slice, links: { pages }, meta: { total: items.length } } };
  };

  const route = (r) => {
    if (!authorized(r)) return unauthorized;
    const p = r.path;
    const get = r.method === 'GET';
    const deny = (name) => fake.forbid.has(name);
    if (get && p === '/v2/droplets')
      return deny('droplets') ? forbidden : page(r, 'droplets', fake.droplets);
    if (get && p === '/v2/account')
      return deny('account') ? forbidden : { status: 200, body: { account: fake.account } };
    if (get && p === '/v2/customers/my/balance') {
      if (deny('balance')) return forbidden;
      const { generatedAgoMs, ...b } = fake.balance;
      return {
        status: 200,
        body: {
          ...b,
          generated_at: new Date(fake.serverNow() - generatedAgoMs)
            .toISOString()
            .replace(/\.\d+Z$/, 'Z'),
        },
      };
    }
    if (get && p === '/v2/monitoring/alerts')
      return deny('alerts') ? forbidden : page(r, 'policies', fake.policies);
    if (get && p === '/v2/uptime/checks')
      return deny('checks') ? forbidden : page(r, 'checks', fake.checks);
    const state = /^\/v2\/uptime\/checks\/([0-9a-f-]+)\/state$/.exec(p);
    if (get && state) {
      if (deny('state')) return forbidden;
      if (!fake.checks.some((c) => c.id === state[1]))
        return error(404, 'not_found', 'The resource you were accessing could not be found.');
      const s = fake.states[state[1]] ?? {
        regions: {
          us_east: {
            status: 'UP',
            status_changed_at: '2026-11-01T00:00:00Z',
            thirty_day_uptime_percentage: 99.95,
          },
          eu_west: {
            status: 'UP',
            status_changed_at: '2026-11-01T00:00:00Z',
            thirty_day_uptime_percentage: 99.9,
          },
        },
      };
      return {
        status: 200,
        body: {
          state: {
            ...s,
            previous_outage: {
              region: 'us_east',
              started_at: '2026-10-01T00:00:00Z',
              ended_at: '2026-10-01T00:02:00Z',
              duration_seconds: 120,
            },
          },
        },
      };
    }
    const dp = /^\/v2\/droplets\/(\d+)(\/actions(?:\/(\d+))?)?$/.exec(p);
    if (dp) {
      const target = fake.droplets.find((d) => String(d.id) === dp[1]);
      if (!target)
        return error(404, 'not_found', 'The resource you were accessing could not be found.');
      if (get && !dp[2]) return { status: 200, body: { droplet: target } };
      if (get && dp[3]) {
        const a = fake.actions.find((x) => String(x.id) === dp[3] && x.resource_id === target.id);
        if (!a)
          return error(404, 'not_found', 'The resource you were accessing could not be found.');
        return { status: 200, body: { action: a.view() } };
      }
      if (r.method === 'POST' && dp[2] && !dp[3]) {
        if (deny('action')) return forbidden;
        let json;
        try {
          json = JSON.parse(r.body);
        } catch {
          return error(400, 'bad_request', 'invalid JSON');
        }
        const type = json?.type;
        if (!['power_on', 'shutdown', 'power_off', 'reboot', 'power_cycle'].includes(type)) {
          return error(422, 'unprocessable_entity', 'Action type not allowed here');
        }
        const s = target.status;
        const valid =
          (type === 'power_on' && s === 'off') ||
          ((type === 'shutdown' || type === 'power_off' || type === 'reboot') && s === 'active');
        if (!valid || target.locked) {
          return error(422, 'unprocessable_entity', 'Droplet already has a pending event.');
        }
        const action = {
          id: (nextAction += 1),
          type,
          resource_id: target.id,
          status: 'in-progress',
          at: performance.now(),
          view() {
            return {
              id: this.id,
              status: this.status,
              type: this.type,
              started_at: '2026-11-27T10:00:00Z',
              completed_at: this.status === 'completed' ? '2026-11-27T10:00:30Z' : null,
              resource_id: this.resource_id,
              resource_type: 'droplet',
              region_slug: 'fra1',
            };
          },
        };
        fake.actions.push(action);
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (fake.failActions) {
            action.status = 'errored';
            return;
          }
          if (type === 'power_on') target.status = 'active';
          if (type === 'shutdown' || type === 'power_off') target.status = 'off';
          action.status = 'completed';
        }, fake.applyDelayMs);
        timers.add(timer);
        return { status: 201, body: { action: action.view() } };
      }
    }
    return error(404, 'not_found', 'The resource you were accessing could not be found.');
  };

  const server = createServer(
    { key: certs.device.key, cert: certs.device.cert },
    async (req, res) => {
      res.on('error', () => {});
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url, 'https://127.0.0.1');
      const r = {
        at: performance.now(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      fake.requests.push(r);
      const latency = typeof fake.latencyMs === 'function' ? fake.latencyMs(r) : fake.latencyMs;
      if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
      if (res.destroyed) return;
      const answer = fake.replyFor?.(r) ?? route(r);
      if (answer === 'silent') return;
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (fake.quota.remaining > 0) fake.quota.remaining -= 1;
      const now = fake.serverNow();
      const text = typeof answer.body === 'string';
      const payload = text ? answer.body : JSON.stringify(answer.body);
      res.writeHead(answer.status, {
        'content-type': text ? 'text/html' : 'application/json; charset=utf-8',
        date: new Date(now).toUTCString(),
        'ratelimit-limit': String(fake.quota.limit),
        'ratelimit-remaining': String(fake.quota.remaining),
        'ratelimit-reset': String(Math.floor(now / 1000) + (fake.quota.resetInS ?? 3600)),
        ...(answer.headers ?? {}),
      });
      res.end(payload);
    },
  );
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  /** The origin the app is given in the tests (never from the configuration). */
  fake.origin = { host: '127.0.0.1', port: fake.port, servername: 'device', ca: certs.device.cert };
  fake.close = async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return fake;
}
