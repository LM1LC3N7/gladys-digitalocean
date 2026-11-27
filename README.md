# gladys-digitalocean

[Gladys Assistant](https://gladysassistant.com) external integration for **DigitalOcean**: the droplets
(status, public IPv4), the usage and balance of the month, the number of alert policies enabled and the state of
the uptime checks, and a Power on button per droplet (Shut down, Force power off and Reboot behind options, off
by default), through the official API v2 with a personal access token (a Read token is recommended).

Unofficial, not affiliated with DigitalOcean. **Never tested with a real device yet** (no real account: written
from the official documentation and its OpenAPI description, tested against a simulated API).

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Costs: the API is free; the account is billed. The integration never creates, resizes nor deletes anything;
  a droplet turned off is still billed.
- Safety: the droplet actions are buttons, never switches; each one is decided on a fresh read of the droplet,
  checked again right before its first byte, and shown as done only once a later read shows it. The quota
  headers (`ratelimit-*`) and 429/5xx are followed; no redirection is followed; the token is never logged.

## Development

```bash
npm install
gi test    # or: npm test (node --test --test-timeout=60000)
gi ci      # format, lint, tests on Node 24 and 22, Docker build, store validator
```

The tests run against the SDK's fake Gladys and a simulated DigitalOcean API on 127.0.0.1 (HTTPS with a
test certificate given as the CA), never the network. `node scripts/mutants.mjs "$(mktemp -d)"` breaks each
guard in a copy and checks a test fails. See `CLAUDE.md` for the architecture and the rules, `TODO.md` for the
decisions and what comes next.

## License

Apache-2.0 (`LICENSE`). Written from the official documentation of the DigitalOcean API; nothing of it is copied.
See `THIRD_PARTY_NOTICES.md`.
