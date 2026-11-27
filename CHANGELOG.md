# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- DigitalOcean over its official API v2 (HTTPS, personal access token in
  `Authorization: Bearer`): the account (usage and balance of the month,
  account balance in US dollars, alert policies enabled, status), the droplets
  (running, status, public IPv4) and the uptime checks (up, status, uptime over
  30 days), as devices of the Discovery.
- Token refused (401 of DigitalOcean on the droplet list): 16-bit salted mark
  in /data, never tried again until a new token or the Test button. A 401/403
  on any other route is never a refusal.
- Droplet buttons: Power on allowed; Shut down, Force power off and Reboot off
  by default. Decided on a fresh read, checked again right before sending, one
  per droplet per 15 s; Power on refused 1 min after a stop (guard written to
  /data before sending); done only once a later read shows it. Never a
  creation, resize, rebuild nor deletion.
- Quota followed (`ratelimit-*` headers against the Date of DigitalOcean): only
  the droplets under 20 % left, reads wait under 25 requests; 429/5xx pause
  (Retry-After, 1 min doubling to 6 h) kept in /data; the last read paces a
  restart.
