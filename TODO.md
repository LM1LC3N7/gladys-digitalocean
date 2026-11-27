# TODO — DigitalOcean v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-27): API v2 client (HTTPS with the CA
      check of Node, Bearer token, error envelope, bounded answers, quota
      headers, no redirection followed), Discovery of the account, droplets and
      uptime checks, balance and alert policies, refusal mark, 429/5xx pause,
      quota waits, droplet buttons (Power on allowed; Shut down, Force power
      off, Reboot behind options) with stop guard in /data and confirmation by
      a later read, docs en/fr. Tested against the SDK's fake Gladys and a
      simulated API over HTTPS on 127.0.0.1. **Never tested with a real
      account.**

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-digitalocean:0.1.0`);
  the first release (patch) gives 0.1.1. SDK `^0.16.1` (latest on npm on
  2026-11-27).
- **Reference**: the official API reference (docs.digitalocean.com/reference/api)
  and its OpenAPI description (github.com/digitalocean/openapi, Apache-2.0),
  read on 2026-11-27. No code copied; notice in `THIRD_PARTY_NOTICES.md`. No
  real account (lot 25 brief): the simulated API follows the documented shapes.
- **Token**: personal access token in `Authorization: Bearer`, format checked
  (letters, digits, `-`, `_`, 20 to 200; "Bearer …" refused with its own
  message). A Read token is recommended and said in the docs; the scopes for
  the buttons listed (droplet:update, never create/delete/admin).
- **Refusal**: only a 401 in the envelope of DigitalOcean (`{ id, message }`)
  on the droplet list (the main read). A 401 without the envelope (a proxy) is
  "not taken"; a 401/403 on the account, balance, alerts, uptime checks or an
  action is never a refusal (custom scopes): that read is held, doubling from
  2 intervals up to 1 h, and the status lists it. 16-bit salted mark in /data
  (a token is 256 random bits; 16 of them never help to find it), lifted by
  the Test button, and at once by another token saved.
- **Buttons**: Power on (`power_on`) allowed; Shut down (`shutdown`), Force
  power off (`power_off`) and Reboot (`reboot`) each behind an option off by
  default, read on the configuration of the moment, also in `beforeSend` (run
  once the TLS connection is up, before `req.end()`: nothing is written
  before). `power_cycle`, `resize`, `rebuild`, `restore`, `snapshot`,
  `password_reset` and every creation or deletion are refused by the client
  itself (only four action types can be sent). No protective action here:
  shutting a droplet down is the sensitive one.
- **Stop guard**: after a shutdown or forced power off, Power on of that
  droplet is refused 60 s; written to /data and waited for (600 ms at most)
  before the first byte; not written: refused, nothing sent. A stop that never
  left, or that DigitalOcean answered with an error, withdraws its guard. A
  stop click bumps the droplet's command counter first: a Power on not sent
  yet is cancelled.
- **Confirmation**: Power on / Shut down / Force power off: the droplet read
  with the status asked (`active`, `off`); Reboot: its action read
  `completed` (GET `/droplets/<id>/actions/<id>`) and the droplet `active`
  (the status before is `active` too: never enough alone). An action read
  `errored` is a failure. Reads after 5/20/60 s (power on, power off), 5/20/60/180 s
  (shutdown), 10/30/90 s (reboot). A locked droplet is refused.
- **Actions on a connection of their own** (`agent: false`): a kept-alive
  socket closed by the server would make the command unknown.
- **Quota**: `ratelimit-limit/remaining/reset` of every answer; reset read
  against the Date of DigitalOcean. Under 20 % of the limit left (read within
  the hour), only the droplets are read; ≤ 25 left, the reads wait until the
  reset (1 min to 1 h); ≤ 3 left during that wait, the commands are refused
  before sending. A 429 pauses with `retry-after`, else the reset (1 h at most), else 1 min,
  doubling with repeated pausing failures up to 6 h; a 5xx the same. Kept in
  /data.
- **Reads**: droplets each interval (120 s default, 60-3600; pages of 200 by
  number, at most 5: the `next` link is never followed), account every 6 h,
  balance and alert policies every hour, uptime check list every 10 min, the
  states of 10 checks per cycle in turn. GPU droplets are not listed (the API
  default).
- **Values**: amounts are decimal texts of DigitalOcean (`"23.44"`, negative
  for a credit); empty, null or text is unknown. The balance is published
  while its `generated_at` is younger than 48 h by the Date of DigitalOcean.
  Alert policies: only the count of enabled ones (the API has no "firing"
  state; their e-mails and Slack URLs are never kept). Uptime: down when a
  region reads DOWN, up when all read UP; uptime = the lowest region.
- **Identity** (review r1: the OpenAPI types these ids as plain strings, its examples
  are 40 characters without dashes; an opaque id `[0-9a-z-]`, 8 to 64, is taken):
  account = the team uuid of `/v2/account` (or the account uuid
  without a team); droplets by their numeric id; checks by their uuid. Another
  token drops everything read with the old one (even through a configuration
  in error in between). The e-mail of the account is never read into memory
  beyond the parser.
- **Feature categories**: amounts `currency`/`decimal` in `dollar` (core
  units); running/up `unknown`/`binary`; counts and uptime `unknown`/`unknown`
  (no core category with a percent of availability); texts `text`; buttons
  `button`/`push`. Transport badge `cloud`.
- **Categories**: `servers`. No `keywords` (rule). World-wide (no `countries`).
- **CI**: `timeout-minutes` added to the jobs of `.github/workflows/ci.yml`
  (a hanging test never holds a runner), as gladys-xen-orchestra.

## Review r1 (2026-11-27)

- Account and team ids taken as the OpenAPI types them (plain strings; its
  examples are 40 characters without dashes): `[0-9a-z-]`, 8 to 64, no `:`;
  the simulated API uses the official examples (with and without a team, and
  a team in RFC 4122 form).
- An action answered 2xx whose body is not understood (`{}`, truncated JSON,
  id in text, a 202) is "sent, without confirmation": guard kept, follow-up
  reads; never "nothing sent".
- A stop no longer cancels another stop of the same droplet (only a Power on
  not sent yet); a second stop while the first runs is refused as busy.
- A Reboot sent without a readable action is said "cannot be confirmed"
  (the droplet runs either way), never "not applied yet".
- A reconnection with the same configuration clears the caches of what was
  sent (`published`, `forgetPublishedStates`) and sends the fresh values.
- One test per guard listed by the review, each in `scripts/mutants.mjs`;
  two equivalents justified there (Scan sooner than the interval, the early
  return of the 240-state budget).

## Review r2 (2026-11-27)

- The Scan guard is not an equivalent: without it, a Scan during the back-off
  of failed reads cut it to the rest of the interval. Tested and in the
  mutants now.
- The account status is sent only while the account was read within 12 h
  (2 periods), as the alert policies.

## Next

- Test with a real account (a Read token, then a custom-scoped one): the
  shapes of `/v2/account` with and without a team, the balance texts, the
  `locked` flag during an action, the 403 body of a missing scope.
- Maybe: droplet monitoring metrics (CPU, memory) through `/v2/monitoring/metrics`.

## Next patch

- Review minors: see `_lots/lot25/reviews/digitalocean-r{1,2,3}.md` (mutants faibles ou équivalents classés mineurs).
