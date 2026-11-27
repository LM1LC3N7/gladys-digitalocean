# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for DigitalOcean: a Node.js service
(Node 22+, ESM, no build step) that runs in its own sandboxed Docker container
and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency, and to `api.digitalocean.com` (API v2).

## Commands

```bash
npm install
gi test                                     # or npm test (node --test --test-timeout=60000)
gi ci                                       # format, lint, Node 24 and 22, Docker, store validator
node --test test/commands.test.js           # one file
memcap node scripts/mutants.mjs "$(mktemp -d)"   # mutation checks of the guards
node scripts/cover.mjs cover.png            # the cover (800x534)
```

## Architecture

```
index.js            SDK wiring only
src/handlers.js     the SDK handlers (shared with the tests)
src/app.js          the app: lifecycle, reads, quota, pauses, Discovery, states, buttons
src/api.js          the HTTPS client of the API v2 and the strict parsers
src/config.js       the configuration, normalized
src/devices.js      the device blueprints and external ids
src/store.js        /data (refusal mark, pause, last read, stop guards)
src/constants.js    paths, timings, limits, keys
src/i18n.js         every text users read (en, fr)
test/helpers/       the simulated API (fakeDo.js) and the setup on the fake Gladys
test/kit/           the clocks and certificates of gladys-testkit
```

- The token travels only in `Authorization: Bearer` to the API, with the CA
  check of Node; never logged, never in /data, a status nor an error.
- A 401 in the envelope of DigitalOcean on the droplet list refuses the token
  (16-bit mark in /data); a 401/403 elsewhere never does.
- Clocks: monotonic for every decision; wall time only for /data; the Date
  header of DigitalOcean for the ages of its data and the quota reset.

## Rules

- **External ids are forever**: `do-account:<id>`, `do-droplet:<id>`,
  `do-uptime:<uuid>`, built with `gladys.externalIds`. The same goes for the
  manifest keys and the feature keys (`src/constants.js` FEATURES).
- **Never a creation, resize, rebuild nor deletion**: the client sends only
  `power_on`, `shutdown`, `power_off`, `reboot`.
- **Sensitive buttons stay off by default** and are never switches.
- **A device published again never loses a feature** (`withCreatedFeatures`).
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  that package.json, the lock and the manifest agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync with
  the code.
- **Tests never touch the network** beyond 127.0.0.1; every wait is bounded
  (a test fails, it never hangs).
