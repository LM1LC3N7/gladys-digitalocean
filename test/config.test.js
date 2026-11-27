// -----------------------------------------------------------------------------
// The configuration: the token format, the options (only true turns one on),
// the interval bounds, and what makes a new session.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, sameSession } from '../src/config.js';
import { TOKEN } from './helpers/fakeDo.js';

test('the token: as the control panel shows it; anything else is an error, never sent', () => {
  assert.equal(normalizeConfig({ token: ` ${TOKEN} ` }).token, TOKEN);
  assert.equal(normalizeConfig({}).error, 'no-token');
  assert.equal(normalizeConfig({ token: `Bearer ${TOKEN}` }).error, 'bearer');
  for (const bad of [`${TOKEN}\r\nX: y`, `${TOKEN};x`, 'short', `a b${TOKEN}`, 'é'.repeat(30)]) {
    const c = normalizeConfig({ token: bad });
    assert.equal(c.error, 'bad-token', bad);
    assert.equal(c.token, '');
  }
});

test('the options: off unless exactly true; the interval bounded; the language', () => {
  const c = normalizeConfig({ token: TOKEN });
  assert.deepEqual(
    [c.allowShutdown, c.allowPowerOff, c.allowReboot, c.pollInterval, c.language],
    [false, false, false, 120, 'fr'],
  );
  for (const v of [1, 'yes', 'on', {}, 'True']) {
    assert.equal(
      normalizeConfig({ token: TOKEN, allow_shutdown: v }).allowShutdown,
      false,
      String(v),
    );
  }
  assert.equal(normalizeConfig({ token: TOKEN, allow_reboot: 'true' }).allowReboot, true);
  assert.equal(normalizeConfig({ token: TOKEN, poll_interval: 5 }).pollInterval, 60);
  assert.equal(normalizeConfig({ token: TOKEN, poll_interval: 1e9 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ token: TOKEN, poll_interval: '' }).pollInterval, 120);
  assert.equal(normalizeConfig({ token: TOKEN, poll_interval: 'abc' }).pollInterval, 120);
  assert.equal(normalizeConfig({ token: TOKEN, language: 'de' }).language, 'fr');
});

test('options only keep the session; another token makes a new one', () => {
  const a = normalizeConfig({ token: TOKEN });
  assert.ok(sameSession(a, normalizeConfig({ token: TOKEN, allow_shutdown: true })));
  assert.ok(!sameSession(a, normalizeConfig({ token: `${TOKEN}x` })));
  assert.ok(!sameSession(a, normalizeConfig({})));
});
