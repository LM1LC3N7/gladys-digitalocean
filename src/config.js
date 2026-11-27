// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized. Nothing here
// talks to the network.
// -----------------------------------------------------------------------------

import { LANGUAGES, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  poll_interval: POLL_INTERVAL.default,
  allow_shutdown: false,
  allow_power_off: false,
  allow_reboot: false,
  language: 'fr',
};

/**
 * A DigitalOcean API token as the control panel shows it (`dop_v1_` and 64
 * hexadecimal digits today; older ones are 64 hexadecimal digits; OAuth ones
 * start with `doo_v1_`). It travels in the Authorization header: nothing else
 * is accepted (no space, no `;`, no control character).
 */
export const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** Only true (or "true") turns an option on: anything else keeps it off. */
const on = (raw) => raw === true || raw === 'true';

const bounded = (raw, { min, max, default: fallback }) => {
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : fallback;
};

function tokenOf(c) {
  const token = typeof c.token === 'string' ? c.token.trim() : '';
  if (token === '') return { error: 'no-token' };
  if (/^bearer\s/i.test(token)) return { error: 'bearer' };
  if (!TOKEN.test(token)) return { error: 'bad-token' };
  return { token };
}

/**
 * @returns {{ token: string, error?: string, pollInterval: number,
 *   allowShutdown: boolean, allowPowerOff: boolean, allowReboot: boolean,
 *   language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const tok = tokenOf(c);
  return {
    token: tok.error ? '' : tok.token,
    error: tok.error,
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    allowShutdown: on(c.allow_shutdown),
    allowPowerOff: on(c.allow_power_off),
    allowReboot: on(c.allow_reboot),
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULT_CONFIG.language,
  };
}

/** Two configurations that run the same way (a reconnection to Gladys keeps everything). */
export const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The parts of the configuration that make another session (the token). */
export const sameSession = (a, b) => a.token === b.token && !a.error && !b.error;
