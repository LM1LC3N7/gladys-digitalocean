// -----------------------------------------------------------------------------
// The integration: one DigitalOcean account (API v2, HTTPS, a personal access
// token), its droplets, its balance, its alert policies and its uptime checks,
// as Gladys devices (Discovery).
//
// Access: the token of the configuration in `Authorization: Bearer`. Refused
// (401 in the envelope of DigitalOcean on the main read, the droplet list):
// kept as a 16-bit mark in /data, never tried again alone (a new token saved,
// or the Test button, tries again). A 401/403 on any other route is never a
// refusal (a token with custom scopes may lack billing:read, monitoring:read,
// uptime:read or droplet:update).
//
// Reads, at the interval (120 s by default), never sooner after the last one,
// even across a restart (/data): the droplets (the main read), then, each at
// its own pace, the account (6 h), the balance (1 h), the alert policies
// (1 h), the uptime checks (10 min) and the state of up to 10 of them in turn.
// Every read but the droplets is secondary: its failure never stops the
// others. A 429 or a 5xx pauses every path (bounded, growing, kept in /data).
// The quota headers of every answer are followed: under 20 % of the hourly
// quota left, only the droplets are read; under 25 requests, the reads wait
// for DigitalOcean to free some (by its own clock).
//
// Droplet buttons (`button`/`push`, never a switch):
//   - Power on is allowed; Shut down, Force power off and Reboot are off by
//     default, one option each, read again right before the first byte.
//   - Each decides on a read of the droplet made after the click, is checked
//     again right before its first byte (option, pause, quota, a newer stop of
//     the droplet, the stop guard, the deadline), runs one at a time per
//     droplet, one per 15 s per droplet, and leaves within 3.5 s or not at all.
//   - A shutdown or forced power off refuses Power on of that droplet for 60 s
//     (a guard written to /data BEFORE the first byte; not written: nothing
//     sent). A Power on not sent yet is cancelled by a stop of the same droplet.
//   - A command is "done" only once a later read shows it (the status asked,
//     or for a reboot its action completed and the droplet running).
//   - The answer to Gladys never waits for a publication nor a status.
//
// Clocks: wall time only for /data; DigitalOcean's Date header (moved on by
// the monotonic clock) for the ages of its data and the quota; monotonic for
// every decision.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { DoError, createApi } from './api.js';
import { normalizeConfig, sameConfig, sameSession } from './config.js';
import { API, BUTTONS, FEATURES, LIMITS, PRESSED, TIMINGS } from './constants.js';
import { buildDevice, idsOf, parseExternalId } from './devices.js';
import { T, accountWord, checkWord, dropletWord, word } from './i18n.js';
import { emptyMemory, fileStore, newSalt, normalizeMemory, tokenMark } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round2 = (n) => Math.round(n * 100) / 100;

/** A command refused or failed, with the text the user reads (in the configured language). */
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

/** A 429 or a 5xx: every path waits. */
export const pausing = (err) => err?.kind === 'rate' || err?.kind === 'server';

/** Fatal for a read cycle: stopped. */
const ending = (err) => err?.kind === 'aborted';

export class DoApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'digitalocean' }),
    store = fileStore(),
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    api = API,
    request,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.origin = api;
    this.request = request;
    this.raw = {};
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'unloaded' | 'loaded' | 'unreadable' */
    this.memoryState = 'unloaded';
    this.generation = 0;
    this.started = false;
    this.closed = false;
    this.connectSeq = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    this.memoryTimer = undefined;
    // Session (reset at each start).
    this.client = null;
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.reading = false;
    this.readTimer = undefined;
    this.lastReadMono = -Infinity;
    this.blocked = false;
    /** The last valid token this run started with (another one drops what was read). */
    this.lastToken = undefined;
    this.pauseEnd = -Infinity;
    /** Pausing failures in a row (the pause grows with them). */
    this.pauses = 0;
    /** The last quota headers: { limit, remaining, resetIn, at (mono) }. */
    this.quota = undefined;
    this.quotaEnd = -Infinity;
    // What was read.
    this.inventory = { droplets: [], overflow: false };
    this.readAt = -Infinity;
    /** The date of DigitalOcean (its Date header) and the monotonic time it was read. */
    this.serverClock = undefined;
    this.account = undefined;
    /** { usage, monthBalance, accountBalance, generatedAt } */
    this.balance = undefined;
    /** { enabled, at (mono) } */
    this.alerts = undefined;
    this.checks = [];
    /** id -> { status, uptime, at (mono) } */
    this.checkStates = new Map();
    this.checksCursor = 0;
    /** name -> next due (mono) of a secondary read. */
    this.due = new Map();
    /** name -> { n, until, err } of a secondary read failing. */
    this.holds = new Map();
    // Commands, per droplet.
    /** id -> { busy, last (mono), epoch } */
    this.dropletCommands = new Map();
    /** id -> end (mono) of the stop guard */
    this.guards = new Map();
    this.followUps = new Set();
    this.unconfirmed = new Set();
    /** The last command result shown in the status: { text, at } */
    this.note = undefined;
    // Gladys side.
    this.created = new Set();
    this.discoveredKey = undefined;
    this.transports = new Map();
    this.lastStatus = undefined;
    this.published = new Map();
    this.stateWindow = [];
    this.stateCursor = 0;
    // Buttons of the configuration screen.
    this.lastTest = undefined;
    this.lastAttemptSaved = -Infinity;
  }

  /** A timer of the app: never armed for an endless, a NaN or a negative delay. */
  later(ms, fn) {
    const delay = Number.isFinite(ms) ? clamp(ms, 0, TIMINGS.rateLimitMax) : TIMINGS.retryMax;
    return this.timers.setTimeout(fn, delay);
  }

  // --- /data ---------------------------------------------------------------------

  /** A promise bounded in time: a slow /data never holds what waits on it. */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.later(ms, () => reject(new Error('timed out')));
      Promise.resolve(promise).then(
        (v) => {
          this.timers.clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** One read of /data at a time (a slow one is waited for by the next try). */
  readStore() {
    if (!this.loading) {
      this.loading = Promise.resolve()
        .then(() => this.store.load())
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }

  async loadMemory() {
    if (this.memoryState !== 'unloaded') return;
    try {
      const raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      if (this.memoryState !== 'unloaded') return;
      this.memory = normalizeMemory(raw, this.now());
      this.memoryState = 'loaded';
    } catch (err) {
      if (this.memoryState !== 'unloaded') return;
      // Unreadable is not empty: nothing is written over it; read again every
      // 10 s (one read at a time), the start goes on meanwhile.
      this.memoryState = 'unreadable';
      this.logger.warn(
        `DigitalOcean: /data unreadable (${err?.message ?? 'error'}): read again in 10 s`,
      );
      this.armMemoryRetry();
    }
    this.memoryTimes();
  }

  /** The pause, the last read and the stop guards kept in /data, applied to the clocks of this run. */
  memoryTimes() {
    const now = this.now();
    const mono = this.mono();
    const left = (this.memory.pausedUntil ?? 0) - now;
    if (left > 0) {
      this.pauseEnd = Math.max(this.pauseEnd, mono + Math.min(left, TIMINGS.rateLimitMax));
    }
    // Written at most once a minute: it may have been up to a minute later than kept.
    if (this.memory.lastReadAt !== null) {
      const ago = Math.max(0, now - this.memory.lastReadAt - TIMINGS.attemptWriteEvery);
      this.lastReadMono = Math.max(this.lastReadMono, mono - ago);
    }
    for (const [id, guard] of Object.entries(this.memory.stopGuards)) {
      if (guard.until > now) {
        const end = mono + Math.min(guard.until - now, TIMINGS.stopGuard);
        this.guards.set(id, Math.max(this.guards.get(id) ?? -Infinity, end));
      }
    }
  }

  armMemoryRetry() {
    if (this.memoryTimer !== undefined || this.closed) return;
    this.memoryTimer = this.later(TIMINGS.dataRetry, async () => {
      this.memoryTimer = undefined;
      if (this.memoryState !== 'unreadable' || this.closed) return;
      let raw;
      try {
        raw = await this.bounded(this.readStore(), TIMINGS.dataWait);
      } catch {
        this.armMemoryRetry();
        return;
      }
      if (this.memoryState !== 'unreadable' || this.closed) return;
      this.adoptLateMemory(raw);
    });
  }

  /** /data read at last: what this run decided meanwhile wins. */
  adoptLateMemory(raw) {
    const late = normalizeMemory(raw, this.now());
    const mine = this.memory;
    if (mine.refused) late.refused = mine.refused;
    late.pausedUntil = Math.max(late.pausedUntil ?? 0, mine.pausedUntil ?? 0) || null;
    late.lastReadAt = Math.max(late.lastReadAt ?? 0, mine.lastReadAt ?? 0) || null;
    for (const [id, guard] of Object.entries(mine.stopGuards)) {
      if (!late.stopGuards[id] || guard.until > late.stopGuards[id].until) {
        late.stopGuards[id] = guard;
      }
    }
    this.memory = late;
    this.memoryState = 'loaded';
    this.memoryTimes();
    this.logger.info('DigitalOcean: /data read');
    this.saveSoon().catch(() => {});
    // A refusal kept for this token stops the reads from now on.
    if (!this.blocked && this.refusalKept()) {
      this.blocked = true;
      this.online = false;
    }
    this.background(this.showStatus());
  }

  /** Writes /data in the background (never awaited on a command path). */
  saveSoon() {
    if (this.memoryState !== 'loaded') return Promise.reject(new Error('/data unreadable'));
    const write = Promise.resolve(this.store.save(this.memory));
    write.catch((err) => this.logger.warn(`DigitalOcean: writing /data failed (${err?.message})`));
    return write;
  }

  /** Writes /data and waits for it, bounded: for what must be kept before going on. */
  async saveNow(ms = TIMINGS.dataWait) {
    if (this.memoryState !== 'loaded') throw new Error('/data unreadable');
    await this.bounded(this.store.save(this.memory), ms);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `DigitalOcean: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(Math.round(wait / 1000)));
      if (seq !== this.connectSeq || this.closed) return;
      this.configTimer = this.later(wait, () => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('DigitalOcean: start failed'));
      });
      return;
    }
    // A configuration saved by the user while getConfig() ran is newer: it wins.
    if (seq !== this.connectSeq || this.closed) return;
    this.configFailures = 0;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw);
  }

  async configUpdated(raw = {}) {
    // Newer than any getConfig() in flight, and than its retry.
    this.connectSeq += 1;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.applyConfig(raw);
  }

  /**
   * The same configuration keeps the session; options only keep it too (an
   * option turned off takes effect at once, even during a read or a command);
   * another token starts again.
   */
  async applyConfig(raw) {
    const next = normalizeConfig(raw);
    if (sameConfig(next, this.config)) {
      this.raw = { ...(raw ?? {}) };
      // Gladys may have restarted: what it keeps in memory only is sent again
      // (status, Discovery, badges), never an old value as a new one.
      this.lastStatus = undefined;
      this.discoveredKey = undefined;
      this.transports.clear();
      // The caches of what was sent go too: the next read sends its values
      // again (never an old value now: only reads still fresh are sent).
      this.published.clear();
      this.gladys.forgetPublishedStates?.();
      this.refreshCreated();
      await this.publishDiscovery();
      await this.publishStates();
      await this.showStatus();
      await this.publishTransports();
      return;
    }
    if (sameSession(next, this.config)) {
      // Options only (buttons, language, interval): set before any wait.
      this.raw = { ...(raw ?? {}) };
      this.config = next;
      this.discoveredKey = undefined;
      if (this.online && !this.reading) {
        const interval = this.readInterval();
        this.scheduleRead(
          this.generation,
          clamp(this.lastReadMono + interval - this.mono(), 0, interval),
        );
      }
      await this.publishDiscovery();
      await this.showStatus();
      return;
    }
    this.logger.info('DigitalOcean: configuration changed, starting again');
    await this.start(raw);
  }

  /**
   * A new session. The first read is `tick`'s to time: never sooner than the
   * interval after the last read (this run, or /data after a restart), nor
   * during a pause; another token reads at once.
   */
  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    this.config = normalizeConfig(raw);
    await this.loadMemory();
    if (!this.current(generation)) return;
    const c = this.config;
    // Against the last valid token of this run (a configuration in error in between changes nothing).
    const tokenChanged =
      c.token !== '' && this.lastToken !== undefined && this.lastToken !== c.token;
    if (c.token) this.lastToken = c.token;
    if (tokenChanged) {
      // Another token (maybe another account): nothing of the old one is kept.
      this.lastReadMono = -Infinity;
      this.holds.clear();
      this.due.clear();
      this.inventory = { droplets: [], overflow: false };
      this.account = undefined;
      this.balance = undefined;
      this.alerts = undefined;
      this.checks = [];
      this.checkStates.clear();
      this.quota = undefined;
      this.quotaEnd = -Infinity;
      this.serverClock = undefined;
      // The refusal kept was the old token's (the mark in /data only serves a restart).
      if (this.memory.refused) {
        this.memory.refused = null;
        this.saveSoon().catch(() => {});
      }
    }
    this.abort = new AbortController();
    this.online = false;
    this.lastError = undefined;
    this.failures = 0;
    this.lastStatus = undefined;
    this.discoveredKey = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.blocked = this.refusalKept();
    if (c.error) {
      await this.showStatus();
      return;
    }
    await this.publishDiscovery();
    await this.showStatus();
    if (!this.current(generation)) return;
    this.scheduleRead(generation, 0);
  }

  /** The reads and the timers of this run end. */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
    this.unconfirmed.clear();
    this.abort.abort();
    this.client?.close();
    this.client = null;
    this.online = false;
    this.reading = false;
    if (shutdown) {
      this.closed = true;
      this.timers.clearTimeout(this.configTimer);
      this.timers.clearTimeout(this.memoryTimer);
      this.memoryTimer = undefined;
      this.configTimer = undefined;
    }
  }

  /** The container stops: everything ends; /data keeps the last state (bounded wait). */
  async shutdown() {
    this.stop({ shutdown: true });
    if (this.memoryState === 'loaded') await this.saveNow().catch(() => {});
  }

  current(generation) {
    return generation === this.generation && !this.closed;
  }

  pauseLeft() {
    return Math.max(0, this.pauseEnd - this.mono());
  }

  paused() {
    return this.pauseLeft() > 0;
  }

  // --- Token, refusal, quota ---------------------------------------------------------

  refusalKept() {
    const r = this.memory.refused;
    const token = this.config.token;
    if (!r || !token) return false;
    return tokenMark(r.salt, token) === r.mark;
  }

  /** The token was refused (401 of DigitalOcean on the droplet list): kept, never tried alone. */
  refuseToken(token) {
    if (token !== this.config.token || this.blocked) return;
    this.blocked = true;
    this.logger.warn(
      'DigitalOcean: the token was refused; waiting for a new one or the Test button',
    );
    const salt = newSalt();
    this.memory.refused = { salt, mark: tokenMark(salt, token) };
    this.saveSoon().catch(() => {});
  }

  clearRefusal() {
    this.blocked = false;
    if (this.memory.refused) {
      this.memory.refused = null;
      this.saveSoon().catch(() => {});
    }
  }

  /**
   * The quota headers of an answer: under 25 requests left, the periodic reads
   * wait until DigitalOcean frees some (its ratelimit-reset against its own
   * Date, 1 min to 1 h).
   */
  noteQuota(quota, token) {
    if (this.closed || token !== this.config.token) return;
    const at = this.mono();
    this.quota = { ...quota, at };
    if (quota.remaining !== undefined && quota.remaining <= LIMITS.quotaFloor) {
      const wait = clamp(
        quota.resetIn ?? TIMINGS.quotaWaitMin,
        TIMINGS.quotaWaitMin,
        TIMINGS.quotaWaitMax,
      );
      this.quotaEnd = Math.max(this.quotaEnd, at + wait);
    }
  }

  quotaWaitLeft() {
    return Math.max(0, this.quotaEnd - this.mono());
  }

  /** Less than 20 % of the hourly quota left (read within the hour): only the droplets are read. */
  quotaLow() {
    const q = this.quota;
    if (!q || q.limit === undefined || q.remaining === undefined || !(q.limit > 0)) return false;
    if (this.mono() - q.at > 3_600_000) return false;
    return q.remaining < q.limit * LIMITS.quotaLowShare;
  }

  /** The quota is used up for a command (it needs a read and a send). */
  quotaSpent() {
    const q = this.quota;
    return (
      this.quotaWaitLeft() > 0 &&
      q?.remaining !== undefined &&
      q.remaining <= LIMITS.quotaCommandFloor
    );
  }

  /** A client of this session (token frozen). */
  sessionClient() {
    if (!this.client) this.client = this.newClient(this.abort.signal);
    return this.client;
  }

  newClient(signal, token = this.config.token) {
    return createApi({
      token,
      origin: this.origin,
      signal,
      request: this.request,
      onQuota: (quota) => this.noteQuota(quota, token),
    });
  }

  // --- Reading -------------------------------------------------------------------

  readInterval() {
    return this.config.pollInterval * 1000;
  }

  scheduleRead(generation, ms) {
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = this.later(ms, () => {
      this.readTimer = undefined;
      if (this.current(generation)) {
        this.tick(generation).catch((err) =>
          this.logger.error(`DigitalOcean loop: ${err?.message}`),
        );
      }
    });
  }

  /** Records the time of a read before it leaves (in /data at most once a minute). */
  noteAttempt() {
    const now = this.mono();
    this.lastReadMono = now;
    if (this.memoryState !== 'loaded') return;
    if (now - this.lastAttemptSaved < TIMINGS.attemptWriteEvery) return;
    this.lastAttemptSaved = now;
    this.memory.lastReadAt = this.now();
    this.saveSoon().catch(() => {});
  }

  /** Why no read can leave now (nothing sent), or undefined. */
  readBlocker() {
    if (this.config.error) return 'config';
    if (this.blocked) return 'token';
    return undefined;
  }

  /** DigitalOcean's time now: its last Date header moved on by the monotonic clock (undefined: unknown). */
  serverNow() {
    if (!this.serverClock) return undefined;
    return this.serverClock.date + (this.mono() - this.serverClock.at);
  }

  noteServerDate(date) {
    if (date !== undefined) this.serverClock = { date, at: this.mono() };
  }

  async tick(generation) {
    if (!this.current(generation) || this.reading) return;
    if (this.readBlocker()) {
      this.online = false;
      await this.showStatus();
      await this.publishTransports();
      return;
    }
    if (this.paused()) {
      await this.showStatus();
      this.scheduleRead(generation, this.pauseLeft());
      return;
    }
    if (this.quotaWaitLeft() > 0) {
      await this.showStatus();
      this.scheduleRead(generation, this.quotaWaitLeft());
      return;
    }
    // Never sooner than the interval after the last read, whoever made it.
    const early = this.lastReadMono + this.readInterval() - this.mono();
    if (early > 0) {
      this.scheduleRead(generation, early);
      return;
    }
    this.reading = true;
    const client = this.sessionClient();
    this.noteAttempt();
    try {
      const droplets = await client.droplets();
      if (!this.current(generation)) return;
      this.noteServerDate(droplets.date);
      this.inventory = { droplets: droplets.items, overflow: droplets.overflow };
      this.readAt = this.mono();
      this.pauses = 0;
      await this.readSecondary(client, generation);
      if (!this.current(generation)) return;
      await this.takeRead();
    } catch (err) {
      if (this.current(generation)) await this.fail(generation, err, client.token);
      return;
    } finally {
      if (this.current(generation)) this.reading = false;
    }
    if (!this.current(generation)) return;
    this.scheduleRead(generation, this.readInterval());
  }

  /** A secondary path due now (its own pace, not held by a failure). */
  isDue(name) {
    const hold = this.holds.get(name);
    if (hold && this.mono() < hold.until) return false;
    return this.mono() >= (this.due.get(name) ?? -Infinity);
  }

  hold(name, err) {
    const n = (this.holds.get(name)?.n ?? 0) + 1;
    const base = Math.max(this.readInterval(), TIMINGS.retryMin);
    this.holds.set(name, {
      n,
      err,
      until: this.mono() + Math.min(TIMINGS.secondaryMax, base * 2 ** n),
    });
    this.logger.debug?.(`DigitalOcean: ${name} not read (${err?.message})`);
  }

  /**
   * A secondary read: its failure never stops the others. A stop ends the
   * cycle; a 429 or a 5xx pauses every path. A 401/403 here is never a
   * refusal of the token.
   */
  async secondary(name, generation, every, fn) {
    if (!this.isDue(name)) return undefined;
    try {
      const value = await fn();
      if (this.current(generation)) {
        this.holds.delete(name);
        this.due.set(name, this.mono() + every);
      }
      return value;
    } catch (err) {
      if (ending(err)) throw err;
      if (pausing(err)) this.pause(err);
      if (this.current(generation)) this.hold(name, err);
      return undefined;
    }
  }

  /** May the next secondary read leave (no pause, no quota trouble)? */
  secondaryOk(generation) {
    return (
      this.current(generation) && !this.paused() && !this.quotaLow() && this.quotaWaitLeft() === 0
    );
  }

  async readSecondary(client, generation) {
    if (!this.secondaryOk(generation)) return;
    const account = await this.secondary('account', generation, TIMINGS.accountEvery, () =>
      client.account(),
    );
    if (!this.current(generation)) return;
    if (account) {
      if (this.account && this.account.id !== account.id) {
        // Another account behind the same token (team moved): its values go.
        this.balance = undefined;
        this.alerts = undefined;
      }
      this.account = account;
    }
    if (!this.secondaryOk(generation)) return;
    const balance = await this.secondary('balance', generation, TIMINGS.balanceEvery, () =>
      client.balance(),
    );
    if (!this.current(generation)) return;
    if (balance) {
      this.noteServerDate(balance.date);
      this.balance = balance;
    }
    if (!this.secondaryOk(generation)) return;
    const alerts = await this.secondary('alerts', generation, TIMINGS.alertsEvery, () =>
      client.alerts(),
    );
    if (!this.current(generation)) return;
    if (alerts) this.alerts = { enabled: alerts.enabled, at: this.mono() };
    if (!this.secondaryOk(generation)) return;
    const checks = await this.secondary('checks', generation, TIMINGS.checksEvery, () =>
      client.checks(),
    );
    if (!this.current(generation)) return;
    if (checks) {
      this.checks = checks.items.slice(0, LIMITS.checks);
      const keep = new Set(this.checks.map((c) => c.id));
      for (const id of this.checkStates.keys()) if (!keep.has(id)) this.checkStates.delete(id);
    }
    await this.readCheckStates(client, generation);
  }

  /** The state of up to 10 enabled uptime checks per cycle, in turn (each failure stays its own). */
  async readCheckStates(client, generation) {
    const enabled = this.checks.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return;
    const count = Math.min(LIMITS.statesPerCycle, enabled.length);
    const start = this.checksCursor % enabled.length;
    this.checksCursor = start + count;
    for (let i = 0; i < count; i += 1) {
      if (!this.secondaryOk(generation)) return;
      const check = enabled[(start + i) % enabled.length];
      const state = await this.secondary(`state:${check.id}`, generation, 0, () =>
        client.checkState(check.id),
      );
      if (!this.current(generation)) return;
      if (state) this.checkStates.set(check.id, { ...state, at: this.mono() });
    }
  }

  // --- After a read ------------------------------------------------------------------

  /** A droplet list read (by the loop or the Test button): online, Discovery, states, status. */
  async takeRead() {
    const wasOnline = this.online;
    this.online = true;
    this.failures = 0;
    this.lastError = undefined;
    if (!wasOnline) this.logger.info('DigitalOcean: connected');
    await this.publishDiscovery();
    await this.publishStates();
    await this.showStatus();
    await this.publishTransports();
  }

  retryDelay(err) {
    if (pausing(err)) {
      const quotaReset = err?.kind === 'rate' ? this.quota?.resetIn : undefined;
      const grown = TIMINGS.rateLimitMin * 2 ** Math.max(0, this.pauses - 1);
      return clamp(
        Math.max(err.retryAfter ?? quotaReset ?? 0, grown),
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    const backoff = Math.min(
      TIMINGS.retryMax,
      TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.max(backoff, this.readInterval());
  }

  /** A 429 or a 5xx: every path waits (bounded, growing, kept in /data). */
  pause(err) {
    this.pauses += 1;
    const delay = this.retryDelay(err);
    this.pauseEnd = Math.max(this.pauseEnd, this.mono() + delay);
    this.memory.pausedUntil = Math.max(this.memory.pausedUntil ?? 0, this.now() + delay);
    this.saveSoon().catch(() => {});
    return delay;
  }

  async fail(generation, err, token) {
    this.online = false;
    this.lastError = err;
    // A 401 in the envelope of DigitalOcean on the droplet list: the token is refused.
    if (err?.kind === 'unauth' && err.envelope) {
      this.refuseToken(token);
      if (this.readBlocker()) {
        await this.showStatus();
        await this.publishTransports();
        return;
      }
    }
    this.failures += 1;
    const delay = pausing(err) ? this.pause(err) : this.retryDelay(err);
    if (err instanceof DoError) {
      this.logger.warn(`DigitalOcean: ${err.message} (next read in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('DigitalOcean: unexpected failure', err);
    }
    await this.showStatus();
    await this.publishTransports();
    if (this.current(generation)) this.scheduleRead(generation, delay);
  }

  /** A request that failed on a side path (command, follow-up): a 429 or 5xx pauses. */
  sideError(err) {
    if (pausing(err)) this.pause(err);
  }

  // --- Discovery, states, badges, status ------------------------------------------

  devices() {
    const language = this.config.language;
    const out = [];
    if (this.account) out.push(buildDevice(this.gladys, 'account', this.account, { language }));
    for (const d of this.inventory.droplets) {
      const model = [d.size, d.region].filter(Boolean).join(' ') || undefined;
      out.push(buildDevice(this.gladys, 'droplet', d, { language, model }));
    }
    for (const c of this.checks) out.push(buildDevice(this.gladys, 'check', c, { language }));
    return out;
  }

  async publishDiscovery() {
    if (this.config.error || this.closed) return;
    const devices = this.devices();
    if (devices.length === 0 && !this.online) return;
    const key = JSON.stringify(devices);
    if (key === this.discoveredKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`DigitalOcean: publishing the Discovery failed (${err?.message})`);
    }
  }

  /** The balance is a measure of now while its `generated_at` is younger than 48 h (Date of DigitalOcean). */
  balanceFresh() {
    const b = this.balance;
    const now = this.serverNow();
    if (!b || b.generatedAt === undefined || now === undefined) return false;
    const age = now - b.generatedAt;
    return age >= -10 * 60_000 && age <= TIMINGS.balanceMaxAge;
  }

  /** The values of the last reads for the created features; never a stale value as new. */
  collectStates() {
    const states = [];
    const add = (id, value) => {
      if (value === undefined || value === null || !this.created.has(id)) return;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) states.push({ device_feature_external_id: id, state: value });
      } else {
        states.push({
          device_feature_external_id: id,
          text: String(value).slice(0, LIMITS.textLength),
        });
      }
    };
    const language = this.config.language;
    const now = this.mono();
    // The droplets: from the last read (of the list, or of the droplet itself
    // after a command) only; a failed read publishes nothing.
    const fresh = (at) => now - at <= this.readInterval() + 60_000;
    for (const d of this.inventory.droplets) {
      if (!fresh(d.readAt ?? this.readAt)) continue;
      const ids = idsOf(this.gladys, 'droplet', d.id);
      const running = d.status === 'active' ? 1 : d.status === 'off' ? 0 : undefined;
      add(ids.feature(FEATURES.RUNNING), running);
      add(
        ids.feature(FEATURES.STATUS),
        d.status === undefined ? undefined : dropletWord(d.status, language),
      );
      add(ids.feature(FEATURES.IPV4), d.ipv4);
    }
    if (this.account) {
      const ids = idsOf(this.gladys, 'account', this.account.id);
      if (this.account.status) {
        add(ids.feature(FEATURES.ACCOUNT_STATUS), accountWord(this.account.status, language));
      }
      if (this.balanceFresh()) {
        add(
          ids.feature(FEATURES.MONTH_USAGE),
          this.balance.usage === undefined ? undefined : round2(this.balance.usage),
        );
        add(
          ids.feature(FEATURES.MONTH_BALANCE),
          this.balance.monthBalance === undefined ? undefined : round2(this.balance.monthBalance),
        );
        add(
          ids.feature(FEATURES.ACCOUNT_BALANCE),
          this.balance.accountBalance === undefined
            ? undefined
            : round2(this.balance.accountBalance),
        );
      }
      if (this.alerts && now - this.alerts.at <= 2 * TIMINGS.alertsEvery) {
        add(ids.feature(FEATURES.ALERT_POLICIES), this.alerts.enabled);
      }
    }
    const enabledCount = this.checks.filter((c) => c.enabled !== false).length;
    const stateMaxAge =
      2 * this.readInterval() * Math.max(1, Math.ceil(enabledCount / LIMITS.statesPerCycle)) +
      60_000;
    for (const c of this.checks) {
      const ids = idsOf(this.gladys, 'check', c.id);
      if (c.enabled === false) {
        add(ids.feature(FEATURES.CHECK_STATUS), checkWord('disabled', language));
        continue;
      }
      const s = this.checkStates.get(c.id);
      if (!s || now - s.at > stateMaxAge) continue;
      add(ids.feature(FEATURES.UP), s.status === 'up' ? 1 : s.status === 'down' ? 0 : undefined);
      if (s.status) add(ids.feature(FEATURES.CHECK_STATUS), checkWord(s.status, language));
      add(ids.feature(FEATURES.UPTIME), s.uptime);
    }
    return states;
  }

  /**
   * Only what changed (or an unchanged value older than 30 min), within 240
   * states a minute; what does not fit goes at the next read, in turn (never
   * the same features left out each time).
   */
  async publishStates() {
    if (this.config.error || this.closed) return;
    const now = this.mono();
    const key = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
    const all = this.collectStates().filter((s) => {
      const last = this.published.get(s.device_feature_external_id);
      return !last || last.key !== key(s) || now - last.at >= TIMINGS.stateHeartbeat;
    });
    if (all.length === 0) return;
    this.stateWindow = this.stateWindow.filter((t) => now - t < 60_000);
    const room = LIMITS.statesPerMinute - this.stateWindow.length;
    if (room <= 0) return;
    const start = this.stateCursor % all.length;
    const states = [...all.slice(start), ...all.slice(0, start)].slice(0, room);
    this.stateCursor = start + states.length;
    for (const s of states) {
      this.stateWindow.push(now);
      this.published.set(s.device_feature_external_id, { key: key(s), at: now });
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: TIMINGS.stateHeartbeat });
    } catch (err) {
      for (const s of states) this.published.delete(s.device_feature_external_id);
      this.logger.warn(`DigitalOcean: sending the states failed (${err?.message})`);
    }
  }

  /** The badge of each created device: unreachable while DigitalOcean is not read. */
  async publishTransports() {
    if (this.config.error || this.closed) return;
    const out = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(this.gladys, device?.external_id);
      if (!parsed || parsed.feature !== null) continue;
      let badge = { transport: DEVICE_TRANSPORTS.CLOUD };
      if (!this.online) badge = { transport: DEVICE_TRANSPORTS.UNREACHABLE };
      else if (parsed.kind === 'droplet' && this.unconfirmed.has(parsed.id)) {
        badge = {
          transport: DEVICE_TRANSPORTS.CLOUD,
          degraded: true,
          message: T.badge.unconfirmed,
        };
      } else if (!this.known(parsed.kind, parsed.id)) {
        badge = { transport: DEVICE_TRANSPORTS.CLOUD, degraded: true, message: T.badge.missing };
      }
      const key = JSON.stringify(badge);
      if (this.transports.get(device.external_id) === key) continue;
      this.transports.set(device.external_id, key);
      out.push({ external_id: device.external_id, ...badge });
    }
    if (out.length === 0) return;
    await this.gladys
      .publishTransports(out)
      .catch((err) => this.logger.warn(`DigitalOcean: badges failed (${err?.message})`));
  }

  /** The object of a created device is in the last read (an account or check not read stays known). */
  known(kind, id) {
    if (kind === 'droplet') return this.inventory.droplets.some((d) => d.id === id);
    if (kind === 'account') return !this.account || this.account.id === id;
    return this.checks.length === 0 || this.checks.some((c) => c.id === id);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) =>
        this.logger.warn(`DigitalOcean: setConnectionStatus failed (${err?.message})`),
      );
  }

  /** The status from what is known now (one text, bounded). */
  statusText() {
    const c = this.config;
    const parts = [];
    let connected = false;
    if (c.error) parts.push(T.configError(c.error));
    else if (this.blocked) parts.push(T.tokenRefused);
    else if (this.paused()) parts.push(T.paused(Math.ceil(this.pauseLeft() / 60_000)));
    else if (this.online) {
      connected = true;
      const { droplets } = this.inventory;
      parts.push(
        T.connected({
          droplets: droplets.length,
          running: droplets.filter((d) => d.status === 'active').length,
          checks: this.checks.length,
          interval: c.pollInterval,
        }),
      );
      if (this.inventory.overflow) parts.push(T.overflow);
    } else if (this.lastError) parts.push(T.failure(this.lastError));
    else parts.push(T.connecting);
    if (!c.error && !this.blocked) {
      if (this.quotaWaitLeft() > 0)
        parts.push(T.quotaWait(Math.ceil(this.quotaWaitLeft() / 60_000)));
      else if (this.quotaLow()) parts.push(T.quotaLow);
      const notRead = ['account', 'balance', 'alerts', 'checks'].filter((n) => this.holds.has(n));
      if (this.online && notRead.length > 0) parts.push(T.notRead(notRead));
    }
    if (this.note && this.mono() - this.note.at < TIMINGS.noteKeep) parts.push(this.note.text);
    if (this.memoryState === 'unreadable') parts.push(T.dataUnreadable);
    return { connected, message: T.join(parts) };
  }

  async showStatus() {
    if (this.closed) return;
    const { connected, message } = this.statusText();
    await this.setStatus(connected, message);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(`DigitalOcean: ${err?.message}`));
  }

  // --- Devices created by the user -------------------------------------------------

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * A device created (or updated): the SDK forgot its values, so they are sent
   * again, from the last reads only while they are recent (never an old value as new).
   */
  async deviceCreated(device) {
    this.refreshCreated();
    for (const f of device?.features ?? []) {
      this.created.add(f.external_id);
      this.published.delete(f.external_id);
    }
    if (device?.external_id) this.transports.delete(device.external_id);
    if (this.online) await this.publishStates();
    await this.publishTransports();
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) this.transports.delete(device.external_id);
  }

  /** The Scan button: the Discovery again; never a read sooner than the interval after the last one. */
  async scan() {
    this.discoveredKey = undefined;
    await this.publishDiscovery();
    const generation = this.generation;
    if (this.reading || this.mono() - this.lastReadMono < this.readInterval()) return;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    await this.tick(generation);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(code, ...args) {
    const text = T.denied[code];
    return new Refusal(
      code,
      word(typeof text === 'function' ? text(...args) : text, this.config.language),
    );
  }

  /** The result of a command, kept in the status for 10 min (setValue's answer reaches no one). */
  noteResult(text) {
    this.note = { text, at: this.mono() };
    this.background(this.showStatus());
    this.background(this.publishTransports());
  }

  dropletCommand(id) {
    let state = this.dropletCommands.get(id);
    if (!state) {
      state = { busy: false, last: -Infinity, epoch: 0, running: undefined };
      this.dropletCommands.set(id, state);
    }
    return state;
  }

  guardLeft(id) {
    return Math.max(0, (this.guards.get(id) ?? -Infinity) - this.mono());
  }

  async setValue(_device, feature, value) {
    // The deadline counts from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed || parsed.feature === null) throw this.refusal('unknown');
    const button = parsed.kind === 'droplet' ? BUTTONS[parsed.feature] : undefined;
    if (!button) throw this.refusal('readOnly');
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw this.refusal('badValue');
    return this.command(parsed.id, parsed.feature, button, received);
  }

  /** Every check of a command (again right before its first byte), on the configuration of now. */
  check(id, key, button, state, epoch) {
    const c = this.config;
    if (c.error) throw this.refusal('notConfigured');
    if (button.option && c[button.option] !== true) throw this.refusal(`${key}Off`);
    if (this.blocked) throw this.refusal('tokenRefused');
    if (this.paused()) throw this.refusal('paused', Math.ceil(this.pauseLeft() / 1000));
    if (this.quotaSpent()) throw this.refusal('quota');
    if (!button.stop && state.epoch !== epoch) throw this.refusal('stopArrived');
    if (key === FEATURES.POWER_ON && this.guardLeft(id) > 0) {
      throw this.refusal('stopGuard', Math.ceil(this.guardLeft(id) / 1000));
    }
  }

  /** What the droplet read allows: 'send', or a note (nothing to do), or a refusal thrown. */
  decide(key, d) {
    if (d.status === undefined) throw this.refusal('stateUnknown');
    if (d.locked !== false) throw this.refusal(d.locked === true ? 'locked' : 'stateUnknown');
    const s = d.status;
    if (key === FEATURES.POWER_ON) {
      if (s === 'active') return T.result.alreadyOn;
      if (s !== 'off') throw this.refusal('startState', s);
      return 'send';
    }
    if (key === FEATURES.SHUTDOWN || key === FEATURES.POWER_OFF) {
      if (s === 'off') return T.result.alreadyOff;
      if (s !== 'active') throw this.refusal('notRunning', s);
      return 'send';
    }
    if (s !== 'active') throw this.refusal('notRunning', s);
    return 'send';
  }

  /** Sets the stop guard of a droplet (Power on refused for 60 s) and waits for /data to keep it. */
  async setGuard(id) {
    if (this.memoryState !== 'loaded') throw this.refusal('dataNotKept');
    const before = this.memory.stopGuards[id];
    const beforeMono = this.guards.get(id);
    this.memory.stopGuards[id] = { until: this.now() + TIMINGS.stopGuard };
    const entries = Object.entries(this.memory.stopGuards);
    if (entries.length > LIMITS.guards) {
      entries.sort((a, b) => a[1].until - b[1].until);
      for (const [old] of entries.slice(0, entries.length - LIMITS.guards)) {
        delete this.memory.stopGuards[old];
      }
    }
    this.guards.set(id, this.mono() + TIMINGS.stopGuard);
    const undo = () => {
      if (before) this.memory.stopGuards[id] = before;
      else delete this.memory.stopGuards[id];
      if (beforeMono === undefined) this.guards.delete(id);
      else this.guards.set(id, beforeMono);
    };
    try {
      await this.saveNow(TIMINGS.guardSaveWait);
    } catch {
      undo();
      this.saveSoon().catch(() => {});
      throw this.refusal('dataNotKept');
    }
    return undo;
  }

  /**
   * One droplet command: decided on a read of the droplet made after the
   * click; one at a time per droplet, one per 15 s per droplet; sent within
   * 3.5 s of the click or not at all; "done" only once a later read shows it.
   * Nothing here waits for a publication nor a status.
   */
  async command(id, key, button, received) {
    const deadline = received + TIMINGS.commandBudget;
    // The session clicked: another token saved meanwhile cancels the command.
    const generation = this.generation;
    const state = this.dropletCommand(id);
    // A stop is newer than anything waiting for this droplet: a Power on not sent yet is cancelled.
    if (button.stop) state.epoch += 1;
    const epoch = state.epoch;
    this.check(id, key, button, state, epoch);
    if (state.busy) {
      throw this.refusal(
        button.stop && state.running === FEATURES.POWER_ON ? 'busyCancelled' : 'busy',
      );
    }
    const since = this.mono() - state.last;
    if (since < TIMINGS.commandSpacing) {
      throw this.refusal('spacing', Math.ceil((TIMINGS.commandSpacing - since) / 1000));
    }
    state.busy = true;
    state.running = key;
    let undoGuard;
    let left = false;
    try {
      const client = this.sessionClient();
      let droplet;
      try {
        ({ droplet } = await client.droplet(id, {
          timeout: Math.max(200, deadline - TIMINGS.sendReserve - this.mono()),
        }));
      } catch (err) {
        this.sideError(err);
        if (err?.kind === 'notfound') throw this.refusal('gone');
        throw this.refusal('readFailed', err);
      }
      if (!this.current(generation)) throw this.refusal('configChanged');
      this.updateDroplet(droplet);
      const decision = this.decide(key, droplet);
      if (decision !== 'send') {
        this.noteResult(decision);
        return undefined;
      }
      // Nothing changed during the read (option, newer stop, pause, quota, guard).
      this.check(id, key, button, state, epoch);
      if (button.stop) undoGuard = await this.setGuard(id);
      if (this.mono() > deadline - 300) throw this.refusal('tooLate');
      const beforeSend = () => {
        if (!this.current(generation)) throw this.refusal('configChanged');
        this.check(id, key, button, state, epoch);
        if (this.mono() > deadline - 100) throw this.refusal('tooLate');
        state.last = this.mono();
        left = true;
      };
      let action;
      try {
        action = await client.action(id, button.action, {
          timeout: Math.max(100, deadline - this.mono()),
          beforeSend,
        });
      } catch (err) {
        if (err instanceof Refusal) throw err;
        this.sideError(err);
        // No answer, a success status not understood, or a 5xx after the
        // request left: DigitalOcean may have taken it.
        const maybe =
          left &&
          err?.sent &&
          (!err.answered || (err.status >= 200 && err.status < 300) || err.kind === 'server');
        if (maybe) {
          this.noteResult(T.result.unconfirmed(key));
          // Read again on the same session only (never another account's droplet).
          if (this.current(generation)) {
            this.unconfirmed.add(id);
            this.followUp(id, key, button, undefined);
          }
          throw this.refusal('unconfirmed');
        }
        if (left && err?.answered) {
          // DigitalOcean answered with an error: it did nothing.
          undoGuard?.();
          undoGuard = undefined;
          this.saveSoon().catch(() => {});
          this.noteResult(T.result.refused(key, err));
          throw this.refusal('refusedByDo', err);
        }
        this.noteResult(T.result.nothingSent(key, err));
        throw this.refusal('nothingSent', err);
      }
      this.unconfirmed.add(id);
      this.noteResult(T.result.sent(key));
      this.followUp(id, key, button, action.id);
      return undefined;
    } catch (err) {
      // Never left: the guard of this command is withdrawn ("nothing sent").
      if (!left && undoGuard) {
        undoGuard();
        this.saveSoon().catch(() => {});
      }
      throw err;
    } finally {
      state.busy = false;
    }
  }

  /** A droplet read again (command, follow-up): its values replace the old ones. */
  updateDroplet(d) {
    const list = this.inventory.droplets;
    const i = list.findIndex((x) => x.id === d.id);
    if (i < 0) return;
    list[i] = { ...list[i], ...d, name: list[i].name, readAt: this.mono() };
  }

  /**
   * Reads after a command (they do not count as the reads of the interval):
   * done once the status asked is read (a reboot: its action completed, then
   * the droplet running); a read equal to the state before is "not applied
   * yet"; an action read "errored" is a failure.
   */
  followUp(id, key, button, actionId) {
    const delays = TIMINGS.confirm[button.action];
    const generation = this.generation;
    const last = Math.max(...delays);
    const timers = [];
    const finish = (text) => {
      for (const t of timers) {
        this.timers.clearTimeout(t);
        this.followUps.delete(t);
      }
      this.unconfirmed.delete(id);
      this.noteResult(text);
    };
    for (const delay of delays) {
      const timer = this.later(delay, async () => {
        this.followUps.delete(timer);
        const final = delay === last;
        if (!this.current(generation) || this.readBlocker() || this.paused()) {
          if (final && this.current(generation)) finish(T.result.notApplied(key, undefined));
          return;
        }
        try {
          const client = this.sessionClient();
          let action;
          if (actionId !== undefined) action = await client.readAction(id, actionId);
          if (!this.current(generation)) return;
          if (action?.status === 'errored') {
            finish(T.result.failed(key));
            return;
          }
          const { droplet } = await client.droplet(id);
          if (!this.current(generation)) return;
          this.updateDroplet(droplet);
          this.background(this.publishStates());
          const done = button.wanted
            ? droplet.status === button.wanted
            : action?.status === 'completed' && droplet.status === 'active';
          if (done) {
            finish(T.result.confirmed(key));
            return;
          }
          if (final) {
            // A reboot sent without a readable action cannot be told from no reboot at all.
            const blind = !button.wanted && actionId === undefined;
            finish(blind ? T.result.cannotConfirm(key) : T.result.notApplied(key, droplet.status));
          }
        } catch (err) {
          this.sideError(err);
          if (final && this.current(generation)) finish(T.result.notApplied(key, undefined));
        }
      });
      timers.push(timer);
      this.followUps.add(timer);
    }
  }

  // --- Configuration screen button ---------------------------------------------------

  async testConnection() {
    await this.loadMemory();
    const now = this.mono();
    if (this.lastTest && now - this.lastTest.at < TIMINGS.testSpacing) return this.lastTest.result;
    const result = await this.runTest();
    this.lastTest = { at: this.mono(), result };
    return result;
  }

  async runTest() {
    const c = this.config;
    if (c.error) return T.configError(c.error);
    const generation = this.generation;
    let client;
    try {
      if (this.paused()) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.pauseLeft() / 1000));
      }
      if (this.quotaWaitLeft() > 0) {
        const { message } = this.statusText();
        return T.test.paused(message, Math.ceil(this.quotaWaitLeft() / 1000));
      }
      const wait = this.lastReadMono + this.readInterval() - this.mono();
      if (wait > 0 && !this.blocked) {
        const { message } = this.statusText();
        return T.test.waiting(message, Math.ceil(wait / 1000));
      }
      this.noteAttempt();
      const token = c.token;
      client = this.newClient(undefined, token);
      let droplets;
      try {
        droplets = await client.droplets();
      } catch (err) {
        if (err?.kind === 'unauth' && err.envelope && this.current(generation)) {
          this.refuseToken(token);
          return T.tokenRefused;
        }
        throw err;
      }
      const ok = T.test.ok(droplets.items.length);
      if (!this.current(generation)) return ok;
      this.noteServerDate(droplets.date);
      this.inventory = { droplets: droplets.items, overflow: droplets.overflow };
      this.readAt = this.mono();
      if (this.blocked) {
        this.clearRefusal();
        this.logger.info('DigitalOcean: token accepted again (Test button)');
        // A new session, which reads at once (its first read is the next one at the interval).
        this.background(
          this.start(this.raw).then(() => (this.config.error ? undefined : this.takeRead())),
        );
      } else {
        this.background(this.takeRead());
      }
      return ok;
    } catch (err) {
      this.sideError(err);
      if (!(err instanceof DoError)) this.logger.error('DigitalOcean: test failed', err);
      return T.failure(err);
    } finally {
      client?.close();
    }
  }
}
