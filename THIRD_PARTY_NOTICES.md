# Third-party notices

This integration is distributed under the Apache License 2.0 (see `LICENSE`).

## DigitalOcean API v2 (protocol documentation)

- Source: the DigitalOcean API reference (https://docs.digitalocean.com/reference/api/) and its OpenAPI
  description (https://github.com/digitalocean/openapi, Apache-2.0), read on 2026-11-27: the introduction
  (`specification/description.yml`: authentication, rate limits), `shared/headers.yml`, `shared/pages.yml`,
  `shared/models/error.yml`, and the resources `droplets`, `actions`, `billing` (balance), `monitoring`
  (alert policies), `uptime` (checks and their state), `account`.
- What was used: the routes (`/v2/droplets`, `/v2/droplets/<id>`, `/v2/droplets/<id>/actions`,
  `/v2/droplets/<id>/actions/<id>`, `/v2/account`, `/v2/customers/my/balance`, `/v2/monitoring/alerts`,
  `/v2/uptime/checks`, `/v2/uptime/checks/<id>/state`), the `page` and `per_page` parameters, the
  `Authorization: Bearer` header, the `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and
  `retry-after` headers, the error envelope `{ id, message }` and the shapes of the answers, to write the
  client and the simulated API of the tests.
- No code is copied or ported from DigitalOcean nor from the OpenAPI repository; none of it is shipped in this
  image: the integration only calls the documented API over the network. No real account was used to write
  or test it.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), installed from npm.
