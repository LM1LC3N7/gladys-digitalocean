# DigitalOcean

This integration reads your DigitalOcean account through its official API v2: your droplets (status, public
IPv4), the usage and balance of the month, the number of alert policies enabled and the state of your uptime
checks. It can power a droplet on; shutting down, forcing the power off and rebooting are off until you allow
them. It never creates, resizes nor deletes anything.

Unofficial integration, not affiliated with DigitalOcean. **Never tested with a real device**: written and tested
from the official API documentation, against a simulated API, without a real account.

## Costs

The DigitalOcean API is free, but your account is billed for your resources. This integration creates nothing
and changes no size: it cannot raise your bill. Beware: **a droplet turned off is still billed** (only deleting
it stops the billing, and the integration never deletes anything).

## Token

In the DigitalOcean control panel: **API**, **Tokens**, **Generate New Token**.

- **Read only (recommended)**: the **Read** scope. Everything is read; the buttons answer that the token is read
  only.
- **For the buttons**: custom scopes with `droplet:read` and `droplet:update`, plus `account:read`,
  `billing:read`, `monitoring:read` and `uptime:read` to read the rest. Add neither `droplet:create`, nor
  `droplet:delete`, nor `droplet:admin`: the integration does not need them.

The token is kept by Gladys in its database, never shown again, sent only to DigitalOcean
(`api.digitalocean.com`, certificate checked). It appears in no log, status nor file of the integration.

If DigitalOcean refuses the token (HTTP 401 on the droplet list: revoked, expired, mistyped), the integration stops
and does not try it again by itself, even after a restart, until you save a new token or click **Test the
connection**. A refusal on another read (billing, alerts, uptime checks) stops nothing: that read is tried again
later, more and more spaced (up to 1 h), and the status says so.

## Devices

From the Discovery:

| Device               | Features                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| DigitalOcean account | Usage this month, balance this month, account balance (US dollars), alert policies enabled, account status |
| A droplet            | Running (yes/no), status, public IPv4; Power on, Shut down, Force power off, Reboot buttons                |
| An uptime check      | Up (yes/no), status, uptime over 30 days (%)                                                               |

- Ids: the account by the id of its team (or of the account without a team), a droplet by its number, an uptime
  check by its DigitalOcean id.
- The usage and balance are those DigitalOcean computes (`generated_at`); older than 48 h, they are not
  published. Read once an hour.
- The alert policies of DigitalOcean (CPU, memory, disk...) expose no "firing" state in the API: only how many
  are enabled is read (their e-mails and Slack URLs are never kept). The up / down state comes from the uptime
  checks: down as soon as one region sees it down.
- An unknown value (empty, unreadable, a droplet being created) is never published as 0.
- GPU droplets are not listed (the API keeps them apart); beyond 1000 droplets, the others are left out and the
  status says so.

## Buttons

They are buttons, never switches: a "turn everything off" of a voice assistant or a scene does not reach them.

- **Power on**: allowed without an option.
- **Shut down** (`shutdown`, clean), **Force power off** (`power_off`, like pulling the plug), **Reboot**
  (`reboot`, clean): each one off by default, to allow in the configuration.

For each press:

1. the option is read again (an option turned off takes effect at once, even during a read or a command);
2. the droplet is read again; the decision is made on that read (already in the state asked: nothing sent;
   locked by DigitalOcean or status unknown: refused);
3. everything is checked again right before sending (option, pause, quota, a newer stop of the same droplet,
   deadline);
4. the request leaves within 3.5 s of the press or not at all;
5. a command is shown as **done** only once a later read shows it (Power on: droplet running; Shut down and
   Force power off: droplet off; Reboot: action completed then droplet running). The reads follow at 5 s, 20 s,
   60 s (180 s for Shut down, 10/30/90 s for Reboot). Without a clear answer, the command is "sent, without
   confirmation" and is never sent again by itself.

Safeguards: one command per droplet per 15 s; one at a time per droplet; after Shut down or Force power off,
Power on of that droplet is refused for 1 min (a guard written to `/data` before sending; if `/data` cannot write
it, nothing is sent), also after a restart; a stop cancels a Power on of the same droplet not sent yet. The result
of each command shows in the status of the integration for 10 min.

Reasons Shut down or Force power off is refused, nothing being sent: option off, integration not configured,
token refused, pause asked by DigitalOcean (429 or 5xx), quota of the token used up, another command running or
less than 15 s since the previous one on that droplet, droplet not found, unreadable, locked or not running,
`/data` not keeping the guard, token changed during the command, DigitalOcean too slow (beyond 3.5 s). With a Read
token, DigitalOcean refuses by itself (HTTP 403).

## Reads and quotas

- The droplets: at each refresh (120 s by default, 60 to 3600 s), never sooner, even after a restart or a click
  on Scan; the account every 6 h; the billing and the alert policies every hour; the list of uptime checks every
  10 min, and the state of up to 10 of them at each refresh, in turn.
- The token allows 5,000 requests per hour (250 per minute), shared with your other tools. The integration follows
  the `ratelimit-*` headers of every answer: under 20 % left, it reads only the droplets; under 25 requests, it
  waits for DigitalOcean to free some (by its clock, 1 min to 1 h).
- A 429 or a 5xx error pauses reads and commands (the `Retry-After` delay, else 1 min, doubled at each repeated
  failure, 6 h at most), kept in `/data`.
- No redirection is followed; answers are bounded in size and time.

## Troubleshooting

- **"DigitalOcean refused the token"**: create a new one, save it (or click Test).
- **"Not read: balance (billing:read)"**: the token lacks this scope; add it or ignore.
- **A button answers "token without the droplet:update scope"**: a Read token, on purpose or not.
- **"Shut down: not applied yet"**: a clean shutdown depends on the system of the droplet; DigitalOcean only makes
  sure the request is issued. Check in the control panel, or use Force power off if you allowed it.
