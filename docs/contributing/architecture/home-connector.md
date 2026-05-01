# Home Connector

The local `packages/home-connector` process is the bridge between Kody's
Cloudflare Worker and devices that are only reachable on the local network.

It is a **remote connector** with `kind: home`. The wire protocol, URL shapes,
and secret configuration for **any** outbound connector are documented in
[Remote connectors](./remote-connectors.md).

## Current adapters

The connector exposes these local-device families:

- Roku discovery and control over SSDP + ECP HTTP
- Lutron HomeWorks QSX discovery and control over mDNS + LEAP TLS
- Samsung TV / Frame discovery and control over mDNS, REST, and local WebSocket
  channels
- Venstar WiFi thermostat status and control over the local REST API
- Tesla Backup Gateway 2 (Powerwall+ leader) customer-scope local-API reads

All surfaces are registered as MCP tools inside the connector and then exposed
to the Worker through the existing outbound WebSocket session to
`HomeConnectorSession`.

## Lutron integration

The Lutron adapter lives under `packages/home-connector/src/adapters/lutron/`
and supports a generic, runtime-discovered subset of HomeWorks QSX capabilities
that have been validated against a live processor and represented in sanitized
mock fixtures:

- discover processors on the local network via `_lutron._tcp`
- persist discovered processor identity locally
- associate credentials with a discovered processor
- authenticate over LEAP on `8081`
- traverse the live area tree from `/area/rootarea`
- read associated zones, control stations, keypad buttons, LED state, and
  virtual buttons when present
- treat keypad buttons as scene-like controls when `virtualbutton` is empty
- press keypad buttons
- set direct zone levels for dimmed/switched loads

The adapter intentionally does not promise:

- dealer/programming changes to the Lutron system
- `8902` support for runtime control
- static scene catalogs independent of live keypad/button discovery

### Discovery and transport notes

- Discovery defaults to `mdns://_lutron._tcp.local`.
- Bonjour advertises processor metadata, but runtime LEAP control/auth uses
  `8081`.
- The more privileged QSX endpoint on `8902` is intentionally ignored in this
  integration because it requires client certificates.

## Samsung TV integration

The Samsung TV adapter lives under
`packages/home-connector/src/adapters/samsung-tv/` and intentionally supports a
conservative subset of capabilities that have been validated against a real
Frame TV:

- discover TVs on the local network
- adopt a discovered TV into managed state
- pair a TV and persist the returned auth token
- fetch device metadata
- send remote keys
- probe a curated known-app registry by app ID
- launch apps by explicit app ID
- best-effort power off and power on
- get and set Art Mode

The adapter does not promise:

- full installed-app enumeration
- named app launch for apps without a known app ID
- guaranteed full power off/on semantics across Frame firmware variants

Power support is intentionally split:

- power off uses the Samsung local remote channel with `KEY_POWEROFF`
- power on uses Wake-on-LAN and the TV's stored MAC address

This works well enough to expose as a connector capability, but it should be
treated as best-effort because Samsung Frame firmware can blur the line between
Art Mode and true standby.

## Venstar thermostat integration

The Venstar adapter lives under `packages/home-connector/src/adapters/venstar/`
and supports LAN-only REST calls to `/query/info`, `/query/sensors`,
`/query/runtimes`, `/control`, and `/settings` for thermostats that have the
local API enabled. Managed thermostats are stored in the connector's local
SQLite database and are added through the home connector UI or Venstar MCP tools
rather than env/file configuration.

Discovery is subnet-scan-only. The connector probes `/query/info` across
`VENSTAR_SCAN_CIDRS` when that env var is set; otherwise it derives private
`/24` networks from local IPv4 interfaces. This avoids the SSDP multicast
fragility that showed up on NAS and Docker bridge deployments while keeping the
user flow aligned with the other managed device integrations.

## Tesla Backup Gateway 2 integration

The Tesla gateway adapter lives under
`packages/home-connector/src/adapters/tesla-gateway/` and exposes the
customer-scope local-API endpoints (`/api/status`, `/api/system_status`,
`/api/system_status/{grid_status,soe}`, `/api/meters/aggregates`,
`/api/operation`, `/api/networks`, `/api/site_info`, `/api/powerwalls`,
`/api/solar_powerwall`, `/api/generators`, `/api/system/update/status`).
Installer-scope endpoints (`/api/installer`, `/api/config`) are deliberately
excluded — site export limits are surfaced from
`site_info.max_site_meter_power_ac` or `system_status.solar_real_power_limit`
instead.

Authentication is `POST /api/login/Basic` with role `customer`. The `email`
field is a free-form audit label and is not validated against tesla.com. The
connector caches the resulting `AuthCookie` / `UserRecord` cookies for ~24h and
single-flights logins per gateway. It also tracks login rate-limit cooldowns —
Tesla's gateway accepts new TCP connections during a cooldown but blackholes
login POSTs, so any login timeout marks a 15-minute cooldown that short-circuits
further attempts before they ever leave the connector.

Discovery probes TCP 443 across `TESLA_GATEWAY_SCAN_CIDRS`, inspects each TLS
cert for the Tesla `O=Tesla, OU=Tesla Energy Products` subject and SAN entries
`DNS:teg, DNS:powerwall`, and combines the result with the local ARP cache to
filter on MAC OUI: `90:03:71` identifies BGW2 leaders, `00:d6:cb` identifies
Powerwall units (which are filtered out because they do not answer `/api/...`).
When `TESLA_GATEWAY_DISCOVERY_URL` is set to an HTTP(S) URL the LAN sweep is
skipped and gateways are read from a JSON feed instead, which is how the
dev/mock server works.

Hosts ending in `.mock.local` are routed directly through the in-process mock
driver (`src/adapters/tesla-gateway/mock-driver.ts`) so dev and test runs never
touch the network stack.

## Local persistence

Unlike the Worker-side home connector session, which persists its own view of
the live socket state in Durable Object storage, the local connector also
persists device-family-specific state on disk.

The connector stores a local SQLite database containing:

- discovered Samsung TV metadata
- whether each TV has been adopted
- the latest pairing token for each TV
- last token verification / auth error details
- discovered Lutron processor metadata
- Lutron credentials associated with each discovered processor
- last Lutron authentication success/error details
- discovered Bond bridges and tokens
- discovered Sonos players
- managed Venstar thermostats
- discovered Tesla gateways and their encrypted customer credentials

By default the database is stored at
`~/.kody/home-connector/home-connector.sqlite`. Operators can override the base
directory with `HOME_CONNECTOR_DATA_PATH` or the full file path with
`HOME_CONNECTOR_DB_PATH`.

This persistence is intentionally local to the connector host so that pairing
survives connector restarts without pushing device-local secrets into Worker
storage.

## Discovery and mocks

Samsung discovery defaults to `mdns://_samsungmsf._tcp.local`.

Lutron discovery defaults to `mdns://_lutron._tcp.local`.

The connector uses one shared pure-JavaScript mDNS discovery path for both
Samsung and Lutron, so discovery behavior is consistent across macOS, Linux, and
containers. Live discovery requires the process or container to have multicast
visibility on the local network.

In local development with `MOCKS=true`, the connector uses mock Samsung TV and
Lutron handlers in the same style as the Roku mocks:

- mock discovery endpoint
- mock device metadata
- mock app status and app launch
- mock pairing/token issuance
- mock remote-key behavior
- mock power state transitions
- mock Art Mode state transitions
- mock Lutron processor discovery
- mock Lutron credential validation
- mock Lutron area/zone/button inventory
- mock Lutron button press and zone-level state transitions

That lets the adapter, MCP surface, and admin routes run in local development
and tests without needing physical local-network devices.
