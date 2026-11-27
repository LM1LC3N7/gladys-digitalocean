// -----------------------------------------------------------------------------
// The Gladys devices of a DigitalOcean account (pure):
//
//   `ext:<selector>:do-account:<uuid>`   the account (its team's uuid when the
//                                        token belongs to a team): usage of
//                                        the month, balances (US dollars),
//                                        alert policies enabled, status
//   `ext:<selector>:do-droplet:<id>`     a droplet: running, status, public
//                                        IPv4; Power on, Shut down, Power
//                                        off, Reboot (buttons)
//   `ext:<selector>:do-uptime:<uuid>`    an uptime check: up, status, uptime
//                                        over 30 days (%)
//
// The ids are those given by DigitalOcean (fixed rule, documented). Every
// reading is read only. The droplet actions are `button`/`push` features,
// never a switch nor a binary: a "turn everything off" of a voice assistant,
// MCP or a `switch` scene action must not reach them.
//
// A device published again never loses a feature: the features of the device
// created in Gladys (`gladys.devices`) are added back when the blueprint
// lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DROPLET_ID } from './api.js';
import { DEVICE_TYPES, FEATURES as F } from './constants.js';
import { featureName, kindName } from './i18n.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const binary = () => reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = () =>
  reading({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const dollars = () =>
  reading({
    category: C.CURRENCY,
    type: T.CURRENCY.DECIMAL,
    unit: U.DOLLAR,
    min: -1_000_000_000,
    max: 1_000_000_000,
  });
// No core category lists a percent for an availability nor a count: `unknown`
// without a unit, the unit in the name (as gladys-esxi, gladys-xen-orchestra).
const plain = (max) => reading({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max });
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

export const KINDS = {
  account: {
    type: DEVICE_TYPES.ACCOUNT,
    id: UUID,
    features: [
      [F.MONTH_USAGE, dollars()],
      [F.MONTH_BALANCE, dollars()],
      [F.ACCOUNT_BALANCE, dollars()],
      [F.ALERT_POLICIES, plain(100_000)],
      [F.ACCOUNT_STATUS, text()],
    ],
  },
  droplet: {
    type: DEVICE_TYPES.DROPLET,
    id: DROPLET_ID,
    features: [
      [F.RUNNING, binary()],
      [F.STATUS, text()],
      [F.IPV4, text()],
      [F.POWER_ON, button()],
      [F.SHUTDOWN, button()],
      [F.POWER_OFF, button()],
      [F.REBOOT, button()],
    ],
  },
  check: {
    type: DEVICE_TYPES.CHECK,
    id: UUID,
    features: [
      [F.UP, binary()],
      [F.CHECK_STATUS, text()],
      [F.UPTIME, plain(100)],
    ],
  },
};

export const idsOf = (gladys, kind, id) => gladys.externalIds(KINDS[kind].type, id);

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(device, devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * The device of an object read from DigitalOcean: `kind` account | droplet |
 * check, `object` { id, name }, `model` a short text.
 */
export function buildDevice(gladys, kind, object, { language = 'fr', model } = {}) {
  const ids = idsOf(gladys, kind, object.id);
  let name;
  if (kind === 'account') name = 'DigitalOcean';
  else if (kind === 'droplet') name = object.name ?? `Droplet ${object.id}`;
  else name = `${kindName(kind, language)} ${object.name ?? object.id.slice(0, 8)}`;
  return withCreatedFeatures(
    {
      name: name.slice(0, 80),
      external_id: ids.device,
      model: (model ?? kindName(kind, language)).slice(0, 80),
      should_poll: false,
      features: KINDS[kind].features.map(([key, definition]) => ({
        name: featureName(kind, key, language),
        external_id: ids.feature(key),
        ...definition,
      })),
    },
    gladys.devices,
  );
}

/**
 * What a device or feature external id of this integration designates:
 * { kind, id, feature } (feature null for a device), or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) return null;
  for (const [kind, { type, id: pattern, features }] of Object.entries(KINDS)) {
    const prefix = gladys.externalId(`${type}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !pattern.test(id ?? '')) return null;
    if (feature === undefined) return { kind, id, feature: null };
    if (!features.some(([key]) => key === feature)) return null;
    return { kind, id, feature };
  }
  return null;
}
