// Mutation checks of the guards: each mutant breaks one guard in a copy of the
// repository and must make a test fail (never hang: the whole process group is
// killed at the deadline). One at a time. Usage, from the repository:
//   memcap node scripts/mutants.mjs "$(mktemp -d)" [name filter]
// The directory given is the agent's own; it is emptied of each copy after use.
// node_modules is copied (never linked) into each copy.

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const C = 'test/commands.test.js';
const A = 'test/app.test.js';
const X = 'test/api.test.js';
const G = 'test/config.test.js';
const R = 'test/realclock.test.js';
const ALL = [C, A, X, G, R, 'test/manifest.test.js', 'test/encoding.test.js'];
const APP = 'src/app.js';
const API = 'src/api.js';
const CFG = 'src/config.js';

/** [name, file, from (found exactly once), to, test files]. */
export const MUTANTS = [
  [
    'option of a button',
    APP,
    'if (button.option && c[button.option] !== true) throw',
    'if (false) throw',
    [C],
  ],
  [
    'newer stop of the droplet',
    APP,
    'if (!button.stop && state.epoch !== epoch) throw',
    'if (false) throw',
    [C],
  ],
  [
    'a stop never cancels a stop',
    APP,
    'if (!button.stop && state.epoch !== epoch) throw',
    'if (state.epoch !== epoch) throw',
    [C],
  ],
  ['a stop bumps the counter', APP, 'if (button.stop) state.epoch += 1;', '', [C]],
  [
    'stop guard',
    APP,
    'if (key === FEATURES.POWER_ON && this.guardLeft(id) > 0) {',
    'if (false) {',
    [C],
  ],
  [
    'pause holds commands',
    APP,
    "if (this.paused()) throw this.refusal('paused'",
    "if (false) throw this.refusal('paused'",
    [C],
  ],
  [
    'refused token holds commands',
    APP,
    "if (this.blocked) throw this.refusal('tokenRefused');",
    '',
    [C, A],
  ],
  ['quota holds commands', APP, "if (this.quotaSpent()) throw this.refusal('quota');", '', [C]],
  ['busy per droplet', APP, 'if (state.busy) {', 'if (false) {', [C]],
  ['spacing per droplet', APP, 'if (since < TIMINGS.commandSpacing) {', 'if (false) {', [C]],
  [
    'check again after the read',
    APP,
    '      // Nothing changed during the read (option, newer stop, pause, quota, guard).\n      this.check(id, key, button, state, epoch);',
    '',
    [C],
  ],
  [
    'check again at the first byte',
    APP,
    "throw this.refusal('configChanged');\n        this.check(id, key, button, state, epoch);",
    "throw this.refusal('configChanged');",
    [C],
  ],
  [
    'deadline at the first byte',
    APP,
    "if (this.mono() > deadline - 100) throw this.refusal('tooLate');",
    '',
    [C],
  ],
  [
    'guard written before sending',
    APP,
    'await this.saveNow(TIMINGS.guardSaveWait);',
    'this.saveSoon().catch(() => {});',
    [C],
  ],
  ['guard withdrawn when never left', APP, 'if (!left && undoGuard) {', 'if (false) {', [C]],
  ['locked droplet', APP, 'if (d.locked !== false) throw', 'if (false) throw', [C]],
  ['power on of a running droplet', APP, "if (s === 'active') return T.result.alreadyOn;", '', [C]],
  ['confirmation by the status', APP, '? droplet.status === button.wanted', '? true', [C]],
  [
    'reboot confirmed by its action',
    APP,
    ": action?.status === 'completed' && droplet.status === 'active';",
    ": droplet.status === 'active';",
    [C],
  ],
  ['errored action', APP, "if (action?.status === 'errored') {", 'if (false) {', [C]],
  [
    'sent without answer never resent',
    APP,
    "          throw this.refusal('unconfirmed');",
    "          await client.action(id, button.action, { timeout: 1000 }).catch(() => {});\n          throw this.refusal('unconfirmed');",
    [C],
  ],
  ['option set before any wait', APP, '      this.config = next;\n', '', [C]],
  ['newer configuration wins over getConfig', APP, '    this.connectSeq += 1;\n', '', [A]],
  [
    'refusal only in the envelope',
    APP,
    "if (err?.kind === 'unauth' && err.envelope) {",
    "if (err?.kind === 'unauth') {",
    [A],
  ],
  [
    'refusal kept at restart',
    APP,
    'return tokenMark(r.salt, token) === r.mark;',
    'return false;',
    [A],
  ],
  ['never faster than the interval', APP, '    if (early > 0) {', '    if (false) {', [A]],
  ['secondary failure held', APP, 'if (hold && this.mono() < hold.until) return false;', '', [A]],
  ['secondary own pace', APP, 'this.due.set(name, this.mono() + every);', '', [A]],
  [
    'secondary 5xx pauses',
    APP,
    '      if (pausing(err)) this.pause(err);\n      if (this.current(generation)) this.hold(name, err);',
    '      if (this.current(generation)) this.hold(name, err);',
    [A],
  ],
  [
    'quota low: droplets only',
    APP,
    'return q.remaining < q.limit * LIMITS.quotaLowShare;',
    'return false;',
    [A],
  ],
  ['quota floor: reads wait', APP, 'this.quotaEnd = Math.max(this.quotaEnd, at + wait);', '', [A]],
  [
    'balance freshness',
    APP,
    'return age >= -10 * 60_000 && age <= TIMINGS.balanceMaxAge;',
    'return true;',
    [A],
  ],
  [
    'pause grows',
    APP,
    'const grown = TIMINGS.rateLimitMin * 2 ** Math.max(0, this.pauses - 1);',
    'const grown = TIMINGS.rateLimitMin;',
    [A],
  ],
  [
    'Retry-After bounded',
    APP,
    '        TIMINGS.rateLimitMin,\n        TIMINGS.rateLimitMax,\n      );',
    '        TIMINGS.rateLimitMin,\n        Infinity,\n      );',
    [A],
  ],
  ['another token drops the old reads', APP, '    if (tokenChanged) {', '    if (false) {', [A]],
  ['no stale droplet value', APP, 'if (!fresh(d.readAt ?? this.readAt)) continue;', '', [A, C]],
  [
    'beforeSend before the first byte',
    API,
    '      try {\n        beforeSend?.();\n      } catch (err) {\n        settle(err);\n        return;\n      }',
    '',
    [X, C],
  ],
  [
    'answer size while streaming',
    API,
    '        if (size > maxBytes) {',
    '        if (false) {',
    [X],
  ],
  ['no answer cut', API, '      sent = true;\n      armIdle();', '      sent = true;', [X]],
  [
    'only four action types',
    API,
    'if (!ACTION_TYPES.includes(type)) throw',
    'if (false) throw',
    [X],
  ],
  ['action answer checked', API, 'if (action.type !== type ||', 'if (false ||', [X]],
  ['another droplet refused', API, 'if (!d || d.id !== id) throw', 'if (!d) throw', [C]],
  [
    'error envelope',
    API,
    "  const envelope =\n    isObject(json) && typeof json.id === 'string' && typeof json.message === 'string';",
    '  const envelope = true;',
    [X, A],
  ],
  [
    'amounts strict',
    API,
    'return /^-?\\d{1,12}(\\.\\d{1,6})?$/.test(text) ? Number(text) : undefined;',
    'return Number(text);',
    [X, A],
  ],
  ['check down wins', API, "if (statuses.includes('down')) status = 'down';", '', [X]],
  [
    'quota reset by the Date of DigitalOcean',
    API,
    'Math.max(0, reset * 1000 - date)',
    'Math.max(0, reset * 1000 - Date.now())',
    [X],
  ],
  [
    'CA check',
    API,
    '        agent,\n      });',
    '        agent,\n        rejectUnauthorized: false,\n      });',
    [X],
  ],
  ['token without CR/LF', CFG, "if (!TOKEN.test(token)) return { error: 'bad-token' };", '', [G]],
  [
    'options only when true',
    CFG,
    "const on = (raw) => raw === true || raw === 'true';",
    'const on = (raw) => Boolean(raw);',
    [G],
  ],
  // Review r1.
  [
    'account id as the OpenAPI shows it',
    API,
    'accountIdOf(a.team.uuid)',
    'uuidOf(a.team.uuid)',
    [A],
  ],
  [
    '2xx not understood: sent',
    API,
    "throw new DoError('format', 'answer not understood', { status });",
    "throw new DoError('format', 'answer not understood');",
    [C],
  ],
  [
    '2xx other than 200/201 not the action',
    API,
    'if (status !== 201 && status !== 200) {',
    'if (false) {',
    [C],
  ],
  [
    '5xx after the send: maybe done',
    APP,
    "(err.status >= 200 && err.status < 300) || err.kind === 'server')",
    '(err.status >= 200 && err.status < 300))',
    [C],
  ],
  [
    'reboot of a droplet off',
    APP,
    "    if (s !== 'active') throw this.refusal('notRunning', s);\n    return 'send';\n  }",
    "    return 'send';\n  }",
    [C],
  ],
  [
    '429 on the read of a command pauses',
    APP,
    "        this.sideError(err);\n        if (err?.kind === 'notfound') throw this.refusal('gone');",
    "        if (err?.kind === 'notfound') throw this.refusal('gone');",
    [C],
  ],
  [
    'follow-ups wait during a pause',
    APP,
    'if (!this.current(generation) || this.readBlocker() || this.paused()) {',
    'if (!this.current(generation) || this.readBlocker()) {',
    [C],
  ],
  [
    'refusal read late from /data',
    APP,
    'if (!this.blocked && this.refusalKept()) {',
    'if (false) {',
    [A],
  ],
  [
    'Test: refusal only in the envelope',
    APP,
    "if (err?.kind === 'unauth' && err.envelope && this.current(generation)) {",
    "if (err?.kind === 'unauth' && this.current(generation)) {",
    [A],
  ],
  [
    'Test never sooner than the interval',
    APP,
    'if (wait > 0 && !this.blocked) {',
    'if (false) {',
    [A],
  ],
  [
    'alert policies freshness',
    APP,
    'if (this.alerts && now - this.alerts.at <= 2 * TIMINGS.alertsEvery) {',
    'if (this.alerts) {',
    [A],
  ],
  [
    'uptime state freshness',
    APP,
    'if (!s || now - s.at > stateMaxAge) continue;',
    'if (!s) continue;',
    [A],
  ],
  [
    'another account drops its values',
    APP,
    '        this.balance = undefined;\n        this.alerts = undefined;',
    '',
    [A],
  ],
  [
    'reboot without an action: cannot confirm',
    APP,
    'finish(blind ? T.result.cannotConfirm(key) : T.result.notApplied(key, droplet.status));',
    'finish(T.result.notApplied(key, droplet.status));',
    [C],
  ],
  [
    'busy message of a second stop',
    APP,
    "button.stop && state.running === FEATURES.POWER_ON ? 'busyCancelled' : 'busy',",
    "button.stop ? 'busyCancelled' : 'busy',",
    [C],
  ],
  ['connected resends the values', APP, '      this.published.clear();\n', '', [A]],
  [
    'Scan keeps the back-off',
    APP,
    'if (this.reading || this.mono() - this.lastReadMono < this.readInterval()) return;',
    '',
    [A],
  ],
  [
    'account status freshness',
    APP,
    'if (this.account.status && now - this.account.at <= 2 * TIMINGS.accountEvery) {',
    'if (this.account.status) {',
    [A],
  ],
];

/** Equivalent mutants, with the reason (no test can tell them apart). */
export const EQUIVALENT = [
  [
    '240 states a minute (early return)',
    APP,
    'if (room <= 0) return;',
    'the window never holds more than 240 (the slice takes at most `room`): without it, slice(0, 0) sends an empty list; the budget itself is tested (150 droplets: 240 states, the rest later)',
  ],
  [
    'later() bounded',
    APP,
    'clamp(ms, 0, TIMINGS.rateLimitMax)',
    'every caller passes a bounded delay: pauses by retryDelay (at most 6 h, mutant "Retry-After bounded"), the other timings are fixed constants',
  ],
  [
    'deadline before the send',
    APP,
    "if (this.mono() > deadline - 300) throw this.refusal('tooLate');",
    'the beforeSend checks the deadline again at the first byte (mutant "deadline at the first byte"); this one only stops before the TLS handshake',
  ],
  [
    'declared content-length',
    API,
    'if (Number.isFinite(declared) && declared > maxBytes) {',
    'the streaming count cuts the same answer a few kilobytes later',
  ],
];

function run(dir, tests, ms) {
  return new Promise((done) => {
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
      done({ code: 'TIMEOUT', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

async function main() {
  const base = process.argv[2];
  const filter = process.argv[3];
  if (!base) throw new Error('give your own temporary directory (mktemp -d)');
  const modules = join(base, 'node_modules');
  cpSync(join(REPO, 'node_modules'), modules, { recursive: true });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  {
    const dir = mkdtempSync(join(base, 'baseline-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const { code } = await run(dir, ALL, 300_000);
      if (code !== 0) {
        console.log('baseline FAILED');
        rmSync(modules, { recursive: true, force: true });
        process.exitCode = 1;
        return;
      }
      console.log('baseline ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  let survived = 0;
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = mkdtempSync(join(base, 'm-'));
    try {
      cpSync(REPO, dir, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
      });
      cpSync(modules, join(dir, 'node_modules'), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const n = text.split(from).length - 1;
      if (n !== 1) {
        console.log(`??       ${name}: ${n} matches`);
        survived += 1;
        continue;
      }
      writeFileSync(path, text.replace(from, to));
      const { code } = await run(dir, tests, 150_000);
      const killed = code !== 0 && code !== 'TIMEOUT';
      if (!killed) survived += 1;
      console.log(`${killed ? 'killed  ' : code === 'TIMEOUT' ? 'HANGS   ' : 'SURVIVED'} ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rmSync(modules, { recursive: true, force: true });
  for (const [name, , , why] of EQUIVALENT) console.log(`equiv.   ${name}: ${why}`);
  process.exitCode = survived > 0 ? 1 : 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
