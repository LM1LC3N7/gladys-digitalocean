// -----------------------------------------------------------------------------
// Constants of the DigitalOcean integration: API paths, timings, limits, keys.
// The API is the public DigitalOcean API v2 (https://docs.digitalocean.com/reference/api/,
// OpenAPI description github.com/digitalocean/openapi, Apache-2.0); nothing of
// it is copied here beyond the names of its routes and fields.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of this integration (its User-Agent). */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return /^\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const USER_AGENT = `gladys-digitalocean/${VERSION} (+https://github.com/LM1LC3N7/gladys-digitalocean)`;

/** The API, in HTTPS with the CA check of Node (the tests give their own server and CA). */
export const API = { host: 'api.digitalocean.com', port: 443 };

/** The device types in the external ids: `ext:<selector>:<type>:<id>` (forever). */
export const DEVICE_TYPES = {
  ACCOUNT: 'do-account',
  DROPLET: 'do-droplet',
  CHECK: 'do-uptime',
};

/** Pages read at most (200 items each); more is "too many", the others left out. */
export const PAGE_SIZE = 200;
export const MAX_PAGES = { droplets: 5, alerts: 3, checks: 1 };

export const PATHS = {
  droplets: (page) => `/v2/droplets?page=${page}&per_page=${PAGE_SIZE}`,
  droplet: (id) => `/v2/droplets/${id}`,
  /** POST { type }: answered 201 with the action. */
  dropletActions: (id) => `/v2/droplets/${id}/actions`,
  dropletAction: (id, actionId) => `/v2/droplets/${id}/actions/${actionId}`,
  account: '/v2/account',
  balance: '/v2/customers/my/balance',
  alerts: (page) => `/v2/monitoring/alerts?page=${page}&per_page=${PAGE_SIZE}`,
  checks: `/v2/uptime/checks?page=1&per_page=${PAGE_SIZE}`,
  checkState: (id) => `/v2/uptime/checks/${id}/state`,
};

/** Refresh interval (seconds). */
export const POLL_INTERVAL = { min: 60, max: 3600, default: 120 };

export const LANGUAGES = ['fr', 'en'];

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

export const FEATURES = {
  // Account
  MONTH_USAGE: 'month_usage',
  MONTH_BALANCE: 'month_balance',
  ACCOUNT_BALANCE: 'account_balance',
  ALERT_POLICIES: 'alert_policies',
  ACCOUNT_STATUS: 'account_status',
  // Droplet
  RUNNING: 'running',
  STATUS: 'status',
  IPV4: 'public_ipv4',
  POWER_ON: 'power_on',
  SHUTDOWN: 'shutdown',
  POWER_OFF: 'power_off',
  REBOOT: 'reboot',
  // Uptime check
  UP: 'up',
  CHECK_STATUS: 'check_status',
  UPTIME: 'uptime_30d',
};

/**
 * The droplet buttons: the action type each one sends, the option that allows
 * it (null: always allowed), whether it stops the droplet, the status it
 * reaches (undefined for a reboot: confirmed by its action, completed). Never
 * a creation, a resize, a rebuild nor a deletion: no such route is called.
 */
export const BUTTONS = {
  [FEATURES.POWER_ON]: { action: 'power_on', option: null, stop: false, wanted: 'active' },
  [FEATURES.SHUTDOWN]: { action: 'shutdown', option: 'allowShutdown', stop: true, wanted: 'off' },
  [FEATURES.POWER_OFF]: {
    action: 'power_off',
    option: 'allowPowerOff',
    stop: true,
    wanted: 'off',
  },
  [FEATURES.REBOOT]: { action: 'reboot', option: 'allowReboot', stop: false, wanted: undefined },
};

export const ACTIONS = {
  TEST: 'test_connection',
};

export const TIMINGS = {
  /** A whole request (connection, TLS, answer). */
  readTimeout: 15_000,
  /** No byte for this long during an answer: the read is cut (a frozen read). */
  idleTimeout: 5000,
  /** A command is answered to Gladys within this (Gladys gives up at 5 s). */
  commandBudget: 3500,
  /** Time kept for /data and the send itself after the read of a command. */
  sendReserve: 1200,
  /** /data write of a stop guard, waited for before the first byte. */
  guardSaveWait: 600,
  /** After a shutdown or a forced power off: Power on of that droplet refused this long. */
  stopGuard: 60_000,
  /** At most one command per droplet per this delay. */
  commandSpacing: 15_000,
  /** Reads that confirm a command, after its answer. */
  confirm: {
    power_on: [5000, 20_000, 60_000],
    shutdown: [5000, 20_000, 60_000, 180_000],
    power_off: [5000, 20_000, 60_000],
    reboot: [10_000, 30_000, 90_000],
  },
  /** Secondary reads, at most this often each. */
  accountEvery: 6 * 3_600_000,
  balanceEvery: 3_600_000,
  alertsEvery: 3_600_000,
  checksEvery: 10 * 60_000,
  /** A secondary read refused or failing: spaced, doubling up to this. */
  secondaryMax: 3_600_000,
  /** 429 / 5xx: pause bounds. */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 3_600_000,
  /** Quota nearly used: reads wait until DigitalOcean frees some, within these bounds. */
  quotaWaitMin: 60_000,
  quotaWaitMax: 3_600_000,
  /** Other failures: back-off bounds. */
  retryMin: 60_000,
  retryMax: 30 * 60_000,
  /** /data: one read at a time, each bounded; unreadable: read again every 10 s. */
  dataWait: 2000,
  dataRetry: 10_000,
  /** The time of the last read written to /data at most this often. */
  attemptWriteEvery: 60_000,
  /** getConfig() failing: tried again after these delays, then every minute. */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** Test button: its last result given again within this delay. */
  testSpacing: 10_000,
  /** An unchanged state sent again this often (it stays recently dated in Gladys). */
  stateHeartbeat: 30 * 60_000,
  /** The balance is published while its `generated_at` is younger than this (Date of DigitalOcean). */
  balanceMaxAge: 48 * 3_600_000,
  /** A command result stays in the status this long. */
  noteKeep: 10 * 60_000,
};

export const LIMITS = {
  /** A page of a list (JSON): a larger one is cut before it is read whole. */
  pageBytes: 4 * 1024 * 1024,
  /** A single object. */
  objectBytes: 256 * 1024,
  /** Uptime check states read per cycle (the next checks in turn). */
  statesPerCycle: 10,
  /** Uptime checks kept. */
  checks: 50,
  /** States sent to Gladys per minute (the host API takes 300). */
  statesPerMinute: 240,
  /** Names shown (droplet, check). */
  nameLength: 64,
  /** A text state. */
  textLength: 40,
  /** Stop guards kept in /data. */
  guards: 200,
  /** Quota left under which the periodic reads wait (the commands keep a margin). */
  quotaFloor: 25,
  /** Quota left under which a command is refused before sending (it needs 2 requests). */
  quotaCommandFloor: 3,
  /** Under this share of the hourly quota left, only the droplets are read. */
  quotaLowShare: 0.2,
};
