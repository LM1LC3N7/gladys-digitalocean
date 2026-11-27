// -----------------------------------------------------------------------------
// The DigitalOcean API v2 (https://api.digitalocean.com/v2), as documented at
// https://docs.digitalocean.com/reference/api/ and in its OpenAPI description
// (github.com/digitalocean/openapi). Only these routes are called:
//   GET  /v2/droplets, /v2/droplets/<id>, /v2/droplets/<id>/actions/<id>,
//        /v2/account, /v2/customers/my/balance, /v2/monitoring/alerts,
//        /v2/uptime/checks, /v2/uptime/checks/<id>/state
//   POST /v2/droplets/<id>/actions with a type among power_on, shutdown,
//        power_off and reboot (never another type: no creation, resize,
//        rebuild, restore nor deletion is possible through this client).
//
// TLS: the CA check of Node, on api.digitalocean.com only (the tests give
// their own server and CA; the configuration never can).
// Access: `Authorization: Bearer <token>`. The token is never logged nor put
// in an error message; errors never carry the path nor an answer's text
// beyond a short, cleaned reason. Redirections are never followed.
// The quota headers (ratelimit-limit, -remaining, -reset) of every answer,
// errors included, are handed to `onQuota`.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { isIPv4 } from 'node:net';
import {
  API,
  BUTTONS,
  LIMITS,
  MAX_PAGES,
  PAGE_SIZE,
  PATHS,
  TIMINGS,
  USER_AGENT,
} from './constants.js';

export class DoError extends Error {
  /**
   * @param {'unauth'|'forbidden'|'notfound'|'rate'|'refused'|'server'|'redirect'|'network'|'tls'|'timeout'|'size'|'format'|'aborted'} kind
   * @param {string} message never a token
   * @param {{ status?: number, sent?: boolean, retryAfter?: number, envelope?: boolean, id?: string }} details
   *   sent: the request was written (it may have been done); status: DigitalOcean
   *   answered; envelope: the error came in the JSON envelope of DigitalOcean
   *   (`{ "id": ..., "message": ... }`); id: its `id`, cleaned.
   */
  constructor(kind, message, { status, sent = false, retryAfter, envelope = false, id } = {}) {
    super(message);
    this.name = 'DoError';
    this.kind = kind;
    this.status = status;
    this.sent = sent || status !== undefined;
    this.retryAfter = retryAfter;
    this.envelope = envelope;
    this.id = id;
  }

  /** DigitalOcean answered (any status): the request reached it. */
  get answered() {
    return this.status !== undefined;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const TLS_CODES =
  /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|ERR_OSSL)/;

const networkError = (err, sent) => {
  if (err instanceof DoError) return err;
  if (!sent && TLS_CODES.test(String(err?.code ?? ''))) {
    return new DoError('tls', 'certificate of the API not valid');
  }
  return new DoError('network', NETWORK[err?.code] ?? 'network error', { sent });
};

/** A short text of DigitalOcean: no control character, nothing that looks like a token. */
export function cleanReason(text, secrets = []) {
  let out = typeof text === 'string' ? text.slice(0, 2000) : '';
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out
    .replace(/[0-9A-Za-z+/=_-]{20,}/g, '***')
    .replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** A non-negative integer of a header, or undefined. */
const headerInt = (v) => {
  const text = String(v ?? '').trim();
  return /^\d{1,12}$/.test(text) ? Number(text) : undefined;
};

/** The time of DigitalOcean (its Date header), ms; undefined when unreadable. */
export const serverTime = (headers) => {
  const t = Date.parse(String(headers?.date ?? ''));
  return Number.isFinite(t) ? t : undefined;
};

/**
 * The quota headers: `limit` per hour, `remaining`, and `resetIn` (ms until the
 * oldest request expires, from ratelimit-reset against the Date of
 * DigitalOcean, never the local clock; undefined without both).
 */
export function quotaOf(headers = {}) {
  const limit = headerInt(headers['ratelimit-limit']);
  const remaining = headerInt(headers['ratelimit-remaining']);
  const reset = headerInt(headers['ratelimit-reset']);
  const date = serverTime(headers);
  if (limit === undefined && remaining === undefined) return undefined;
  const resetIn =
    reset !== undefined && date !== undefined ? Math.max(0, reset * 1000 - date) : undefined;
  return { limit, remaining, resetIn };
}

/** Retry-After (seconds, decimals accepted, or an HTTP date) -> ms, or undefined. */
export function retryAfterOf(value, serverDate) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d{1,9}(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // An HTTP date is compared with DigitalOcean's own Date header, never with
  // the local clock; without a readable one, the default pause applies.
  const date = Date.parse(text);
  const now = Date.parse(String(serverDate ?? ''));
  return Number.isFinite(date) && Number.isFinite(now) ? Math.max(0, date - now) : undefined;
}

/**
 * One request; resolves { status, headers, body }. `beforeSend()` runs once
 * the TLS connection is up, just before the first byte of the request: it may
 * throw to cancel (nothing sent).
 */
export function apiRequest({
  origin = API,
  method,
  path,
  token,
  json,
  timeout = TIMINGS.readTimeout,
  idleTimeout = TIMINGS.idleTimeout,
  maxBytes = LIMITS.objectBytes,
  beforeSend,
  signal,
  agent,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle;
    let req;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      if (err) req?.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => settle(new DoError('aborted', 'stopped', { sent }));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => settle(new DoError('timeout', 'DigitalOcean stopped answering', { sent })),
        idleTimeout,
      );
    };
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (method === 'POST') {
      headers['Content-Length'] = 0;
    }
    const timer = setTimeout(
      () => settle(new DoError('timeout', 'no answer within the delay', { sent })),
      Math.max(1, timeout),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = https.request({
        host: origin.host,
        port: origin.port,
        servername: origin.servername ?? (isIPv4(origin.host) ? undefined : origin.host),
        ca: origin.ca,
        method,
        path,
        headers,
        agent,
      });
    } catch {
      // An invalid header value (refused by Node before any byte is written).
      settle(new DoError('format', 'request not built'));
      return;
    }
    // Nothing is written before the connection is up and beforeSend agreed.
    const go = () => {
      if (settled) return;
      try {
        beforeSend?.();
      } catch (err) {
        settle(err);
        return;
      }
      sent = true;
      armIdle();
      req.end(body);
    };
    req.on('socket', (socket) => {
      if (settled) return;
      if (
        socket.connecting ||
        (socket.encrypted && !socket.authorized && !socket.authorizationError)
      ) {
        socket.once('secureConnect', go);
      } else {
        go();
      }
    });
    req.on('response', (res) => {
      armIdle();
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        settle(new DoError('size', 'answer too large', { status: res.statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(new DoError('size', 'answer too large', { status: res.statusCode }));
          return;
        }
        chunks.push(chunk);
        armIdle();
      });
      res.on('end', () =>
        settle(undefined, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(networkError(err, true)));
    });
    req.on('error', (err) => settle(networkError(err, sent)));
  });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The JSON of an answer, or the DoError it is. Errors of DigitalOcean come as
 * `{ "id": "unauthorized", "message": "Unable to authenticate you" }`. A 401
 * is "token not taken" for the caller to judge (a refusal of the token only on
 * the main read, and only in the envelope); a 403 is "this token lacks the
 * scope".
 */
export function parseAnswer({ status, headers = {}, body }, { secrets = [] } = {}) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  const envelope =
    isObject(json) && typeof json.id === 'string' && typeof json.message === 'string';
  const id = envelope ? cleanReason(json.id, secrets).slice(0, 40) : undefined;
  const at = { status, envelope, id };
  if (status >= 300 && status < 400) {
    throw new DoError('redirect', `redirected (HTTP ${status})`, at);
  }
  if (status === 401) throw new DoError('unauth', 'token not taken (HTTP 401)', at);
  if (status === 403) throw new DoError('forbidden', 'not allowed for this token (HTTP 403)', at);
  if (status === 429) {
    throw new DoError('rate', 'too many requests (HTTP 429)', {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status === 404) throw new DoError('notfound', 'not found (HTTP 404)', at);
  if (status >= 500) {
    throw new DoError('server', `HTTP ${status}`, {
      ...at,
      retryAfter: retryAfterOf(headers['retry-after'], headers.date),
    });
  }
  if (status >= 400) {
    const reason = envelope ? cleanReason(json.message, secrets) : '';
    throw new DoError('refused', reason ? `${reason} (HTTP ${status})` : `HTTP ${status}`, at);
  }
  if (status < 200 || status >= 300) throw new DoError('format', `HTTP ${status}`, at);
  return json;
}

const notDo = () => new DoError('format', 'not an answer of DigitalOcean');

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A name shown in Gladys: printable, no direction override, at most 64 characters (code points). */
export function cleanName(v) {
  if (typeof v !== 'string') return undefined;
  const text = v
    .slice(0, 1000)
    .replace(BIDI, '')
    .replace(/[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return undefined;
  return [...text].slice(0, LIMITS.nameLength).join('').trim();
}

const SLUG = /^[a-z0-9-]{1,40}$/;
const slugOf = (v) => (typeof v === 'string' && SLUG.test(v) ? v : undefined);

/** A droplet id: a positive safe integer, as a string of digits. */
export const DROPLET_ID = /^[1-9]\d{0,15}$/;
export const dropletIdOf = (v) =>
  Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && DROPLET_ID.test(v) && Number.isSafeInteger(Number(v))
      ? v
      : undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidOf = (v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined);

/**
 * The id of an account or a team: the OpenAPI types it as a plain string; its
 * examples are 40 characters without dashes (`5df3e3004a17e242b7c20ca6c9fc25b701a47ece`),
 * some teams show an RFC 4122 UUID. An opaque id, bounded and safe in an
 * external id (no `:`), in small letters.
 */
export const ACCOUNT_ID = /^[0-9a-z][0-9a-z-]{6,62}[0-9a-z]$/;
export const accountIdOf = (v) => {
  if (typeof v !== 'string') return undefined;
  const id = v.toLowerCase();
  return ACCOUNT_ID.test(id) ? id : undefined;
};

const DROPLET_STATES = ['new', 'active', 'off', 'archive'];

/** A droplet of `/droplets` or `/droplets/<id>`: strict values, anything else unknown (never 0). */
export function dropletOf(item) {
  if (!isObject(item)) return undefined;
  const id = dropletIdOf(item.id);
  if (!id) return undefined;
  const v4 = isObject(item.networks) && Array.isArray(item.networks.v4) ? item.networks.v4 : [];
  const publicV4 = v4
    .slice(0, 16)
    .find((n) => isObject(n) && n.type === 'public' && isIPv4(String(n.ip_address ?? '')));
  return {
    id,
    name: cleanName(item.name),
    status: DROPLET_STATES.includes(item.status) ? item.status : undefined,
    locked: typeof item.locked === 'boolean' ? item.locked : undefined,
    ipv4: publicV4 ? publicV4.ip_address : undefined,
    region: slugOf(isObject(item.region) ? item.region.slug : undefined),
    size: slugOf(item.size_slug),
  };
}

/** The `next` page link is there (it is never followed: the next page is asked by number). */
const hasNext = (json) =>
  isObject(json.links) && isObject(json.links.pages) && typeof json.links.pages.next === 'string';

/** The account (`/v2/account`): its id (the team's when it has one) and status; never the e-mail. */
export function accountOf(json) {
  const a = isObject(json) && isObject(json.account) ? json.account : undefined;
  if (!a) throw notDo();
  const team = isObject(a.team) ? accountIdOf(a.team.uuid) : undefined;
  const id = team ?? accountIdOf(a.uuid);
  if (!id) throw notDo();
  const status = ['active', 'warning', 'locked'].includes(a.status) ? a.status : undefined;
  return { id, status };
}

/** An amount of the balance: a decimal text of DigitalOcean ("23.44", "-10.00"), else unknown. */
export function amountOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e12 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  return /^-?\d{1,12}(\.\d{1,6})?$/.test(text) ? Number(text) : undefined;
}

/** The balance (`/v2/customers/my/balance`), in US dollars, with the time it was made. */
export function balanceOf(json) {
  if (!isObject(json)) throw notDo();
  const keys = ['month_to_date_usage', 'month_to_date_balance', 'account_balance'];
  if (!keys.some((k) => k in json)) throw notDo();
  const generated = Date.parse(String(json.generated_at ?? ''));
  return {
    usage: amountOf(json.month_to_date_usage),
    monthBalance: amountOf(json.month_to_date_balance),
    accountBalance: amountOf(json.account_balance),
    generatedAt: Number.isFinite(generated) ? generated : undefined,
  };
}

/** An uptime check of `/v2/uptime/checks`. */
export function checkOf(item) {
  if (!isObject(item)) return undefined;
  const id = uuidOf(item.id);
  if (!id) return undefined;
  return {
    id,
    name: cleanName(item.name),
    enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
  };
}

const CHECK_STATES = { UP: 'up', DOWN: 'down', CHECKING: 'checking' };

/**
 * The state of a check (`/v2/uptime/checks/<id>/state`): down when a region
 * reads DOWN, up when every region read reads UP, checking otherwise; the
 * uptime over 30 days is the lowest of the regions (0 to 100, else unknown).
 */
export function checkStateOf(json) {
  const state = isObject(json) && isObject(json.state) ? json.state : undefined;
  if (!state) throw notDo();
  const regions = isObject(state.regions) ? Object.values(state.regions).slice(0, 16) : [];
  const statuses = [];
  let uptime;
  for (const r of regions) {
    if (!isObject(r)) continue;
    statuses.push(CHECK_STATES[r.status]);
    const pct = r.thirty_day_uptime_percentage;
    if (typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      uptime = uptime === undefined ? pct : Math.min(uptime, pct);
    }
  }
  let status;
  if (statuses.includes('down')) status = 'down';
  else if (statuses.length > 0 && statuses.every((s) => s === 'up')) status = 'up';
  else if (statuses.includes('checking')) status = 'checking';
  return { status, uptime: uptime === undefined ? undefined : Math.round(uptime * 100) / 100 };
}

const ACTION_STATES = ['in-progress', 'completed', 'errored'];
const ACTION_TYPES = Object.values(BUTTONS).map((b) => b.action);

/** An action (`{ action: {...} }`) of a droplet. */
export function actionOf(json) {
  const a = isObject(json) && isObject(json.action) ? json.action : undefined;
  if (!a || !Number.isSafeInteger(a.id) || a.id <= 0) throw notDo();
  return {
    id: a.id,
    status: ACTION_STATES.includes(a.status) ? a.status : undefined,
    type: typeof a.type === 'string' ? a.type.slice(0, 40) : undefined,
    resourceId: dropletIdOf(a.resource_id),
  };
}

/** The keep-alive connections of one client (destroyed by `close()`). */
const newAgent = () => new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });

/**
 * A client of one account: its token is frozen for the client's life (a
 * configuration saved meanwhile never sends its token through an older client).
 * `onQuota(quota, date)` gets the quota headers of every answer.
 */
export function createApi({ token, origin = API, signal, request, onQuota }) {
  const agent = request ? undefined : newAgent();
  const send = request ?? apiRequest;
  const call = async (method, path, options = {}) => {
    const answer = await send({ origin, method, path, token, signal, agent, ...options });
    const quota = quotaOf(answer.headers);
    if (quota) onQuota?.(quota);
    const json = parseAnswer(answer, { secrets: [token] });
    return { json, status: answer.status, date: serverTime(answer.headers) };
  };
  /** A list read page by page (by number; the `next` link only says there is one). */
  const pages = async (pathOf, key, maxPages, parse, o = {}) => {
    const out = [];
    let date;
    let overflow = false;
    for (let page = 1; ; page += 1) {
      const { json, date: d } = await call('GET', pathOf(page), {
        maxBytes: LIMITS.pageBytes,
        ...o,
      });
      date = d ?? date;
      if (!isObject(json) || !Array.isArray(json[key])) throw notDo();
      for (const item of json[key].slice(0, PAGE_SIZE)) {
        const v = parse(item);
        if (v !== undefined) out.push(v);
      }
      if (!hasNext(json) || json[key].length === 0) break;
      if (page >= maxPages) {
        overflow = true;
        break;
      }
    }
    return { items: out, overflow, date };
  };
  return {
    token,
    close: () => agent?.destroy(),
    droplets: (o) => pages(PATHS.droplets, 'droplets', MAX_PAGES.droplets, dropletOf, o),
    /** One droplet read again (a command decides on it). Another id than asked is refused. */
    droplet: async (id, o) => {
      const { json, date } = await call('GET', PATHS.droplet(id), o);
      const d = isObject(json) ? dropletOf(json.droplet) : undefined;
      if (!d || d.id !== id) throw new DoError('format', 'not the droplet asked');
      return { droplet: d, date };
    },
    /** One action of the buttons; answered 201 with the action once DigitalOcean took it. */
    action: async (id, type, o) => {
      if (!ACTION_TYPES.includes(type)) throw new DoError('format', 'action not allowed');
      // A connection of its own (never a kept one the server may have closed
      // meanwhile: a reset would leave the command unknown).
      const { json, status } = await call('POST', PATHS.dropletActions(id), {
        json: { type },
        agent: false,
        ...o,
      });
      if (status !== 201 && status !== 200) {
        throw new DoError('format', `HTTP ${status}`, { status });
      }
      // A 2xx whose body is not understood was taken: never "nothing sent".
      let action;
      try {
        action = actionOf(json);
      } catch {
        throw new DoError('format', 'answer not understood', { status });
      }
      if (action.type !== type || (action.resourceId !== undefined && action.resourceId !== id)) {
        throw new DoError('format', 'not the action asked', { status });
      }
      return action;
    },
    readAction: async (id, actionId, o) => {
      const { json } = await call('GET', PATHS.dropletAction(id, actionId), o);
      const action = actionOf(json);
      if (action.id !== actionId) throw new DoError('format', 'not the action asked');
      return action;
    },
    account: async (o) => accountOf((await call('GET', PATHS.account, o)).json),
    balance: async (o) => {
      const { json, date } = await call('GET', PATHS.balance, o);
      return { ...balanceOf(json), date };
    },
    /** The alert policies enabled (their count only: their e-mails and Slack URLs are never kept). */
    alerts: async (o) => {
      const { items, overflow } = await pages(
        PATHS.alerts,
        'policies',
        MAX_PAGES.alerts,
        (p) => (isObject(p) && typeof p.enabled === 'boolean' ? p.enabled : undefined),
        o,
      );
      return { enabled: overflow ? undefined : items.filter(Boolean).length };
    },
    checks: (o) => pages(() => PATHS.checks, 'checks', MAX_PAGES.checks, checkOf, o),
    checkState: async (id, o) => checkStateOf((await call('GET', PATHS.checkState(id), o)).json),
  };
}
