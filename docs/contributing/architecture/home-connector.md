# Home Connector

The local `packages/home-connector` process is the bridge between Kody's
Cloudflare Worker and devices that are only reachable on the local network.

It is a **remote connector** with `kind: home`. The wire protocol, URL shapes,
and secret configuration for **any** outbound connector are documented in
[Remote connectors](./remote-connectors.md).

## Public-vs-internal boundary

The connector URL paths (for example `/home/connectors/default/...`) are
**WebSocket-only** on the public internet. The Worker entrypoint rejects
non-WebSocket HTTP requests to connector routes with `404` before they reach the
`HomeConnectorSession` Durable Object, and the DO `fetch()` handler itself also
rejects non-upgrade HTTP with `404` as a second layer.

Worker-internal code that needs snapshot or tool data (such as
`packages/worker/src/home/client.ts`) calls Durable Object RPC methods directly
on the stub (`getSnapshot()`, `rpcListTools()`, `rpcCallTool()`), bypassing
`fetch()` entirely. See
[Remote connectors § Internal access](./remote-connectors.md#internal-access-do-rpc-not-http)
for details.

## Current adapters

The connector exposes these local-device families:

- Roku discovery and control over SSDP + ECP HTTP
- Lutron HomeWorks QSX discovery and control over mDNS + LEAP TLS
- Samsung TV / Frame discovery and control over mDNS, REST, and local WebSocket
  channels
- Venstar WiFi thermostat status and control over the local REST API
- Island router diagnostics and guarded writes over SSH using one typed command
  catalog
- Access Networks Unleashed / RUCKUS Unleashed WiFi controller reads and typed
  high-risk writes over the local AJAX management interface

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

## Island router diagnostics integration

The Island router adapter lives under
`packages/home-connector/src/adapters/island-router/` and intentionally limits
itself to typed allowlisted SSH commands from the connector host to the local
router. The default posture is read-only diagnostics. Write-risk catalog entries
are available only when SSH host verification is configured and the caller
supplies a strict reason plus exact confirmation phrase. It is designed for
situations where Kody only has network reachability to the router from the NAS
or other machine running the home connector.

The adapter exposes a small Access-Networks-Unleashed-style surface:

- `router_get_status` for connectivity/configuration readiness plus a compact
  status snapshot from `show version`, `show clock`, `show interface summary`,
  and `show ip neighbors`
- `router_run_command` for one command id/template from the typed command
  catalog. It never accepts arbitrary CLI text. Each entry defines exact CLI
  rendering, read/write access, risk level, required params and validators, CLI
  context (`exec`, `configure terminal`, or `interface <iface>`), optional
  no/remove variants, persistence metadata, blast-radius guidance, and a docs
  URL when available.

The catalog includes documented read commands such as `show clock`,
`show version`, `show running-config`, `show startup-config`,
`show interface summary`, `show interface`, `show ip interface`,
`show ip neighbors`, `show ip dhcp-reservations`, `show log`, `show syslog`,
`show stats`, and `ping`. It also includes guarded write entries such as
`clear dhcp-client`, `clear log`, `write memory`, `ip dhcp-reserve`,
`no ip dhcp-reserve`, selected interface-context commands, `syslog server`, and
`ip port-forward`. Extremely destructive operations such as `clear everything`,
`clear network`, rollback/update flows, SSH key regeneration, password changes,
and backup/restore remain omitted.

The adapter intentionally does not expose guessed aliases such as `show-ip-arp`,
`show-ip-sessions`, or `show-log-recent`, nor unsupported public commands such
as `show ip nat`, `show ip counters`, `show ip top`, or `show ip dns stats`.
Higher-level router workflows are expected to live in packages that wrap the
generic command substrate with typed helpers.

The adapter explicitly does not expose:

- arbitrary shell or CLI command execution over MCP
- arbitrary mutating router commands beyond the explicit command catalog
- password-based auth flows through MCP

## Island Router HTTP API proxy integration

The Island Router HTTP API proxy adapter lives under
`packages/home-connector/src/adapters/island-router-api/` alongside the SSH
diagnostics adapter. It lets the Worker drive `my.islandrouter.com` through the
home connector WebSocket when the connector host is inside the user's LAN and can
resolve `my.islandrouter.com` through the router's intercepting DNS. It will not
work from a host outside that LAN path.

The adapter stores the user's Island PIN locally in SQLite, encrypted with
`HOME_CONNECTOR_SHARED_SECRET`. The PIN is supplied through
`island_router_api_set_pin`; it is not read from env. Access, refresh, and
session JWTs are cached in memory only. Each session starts with the Island
`POST /api/startup` challenge, computes the HOTP value from the returned base32
secret and offset, then posts the saved PIN plus OTP. Subsequent proxied calls
use the access token and retry once after `POST /api/refresh` on `401`.

Configuration:

- `ISLAND_ROUTER_API_BASE_URL` defaults to `https://my.islandrouter.com`
- `ISLAND_ROUTER_API_REQUEST_TIMEOUT_MS` defaults to `8000` with a minimum of
  `1000`
- `ISLAND_ROUTER_API_ALLOW_INSECURE_TLS=true` allows self-signed LAN TLS for this
  adapter only

The MCP surface is intentionally generic:

- `island_router_api_get_status`
- `island_router_api_set_pin`
- `island_router_api_clear_pin`
- `island_router_api_request`

`island_router_api_request` accepts `GET`, `POST`, `PUT`, and `DELETE` for paths
under `/api/`. Non-GET calls require `acknowledgeHighRisk: true`, an operator
reason of at least 20 characters, and the exact confirmation phrase. Higher-level typed utilities are
expected to live in packages that wrap this generic proxy.

Write-risk catalog entries are intentionally hard to use because mistakes can
have severe consequences. Agents must be highly certain before using them. The
MCP surface requires:

- SSH host verification via `known_hosts` or a pinned host fingerprint
- typed command ids plus structured params instead of free-form CLI
- an operator reason and an exact confirmation phrase for write-risk entries
- destructive tool annotations and warning-heavy descriptions

Commands that change running configuration do not silently run `write memory`.
When a catalog result reports `persistence.requiresWriteMemory=true`, callers
must review the output and run the separate `write memory` catalog command
explicitly if the change should persist across reboot.

SSH transport is conservative:

- public-key authentication only
- private key path comes from local connector env/runtime config
- host verification can use either a mounted `known_hosts` file or an expected
  host fingerprint
- the Docker image includes the OpenSSH client utilities needed for `ssh`,
  `ssh-keyscan`, and fingerprint verification

## Access Networks Unleashed WiFi integration

The Access Networks Unleashed adapter lives under
`packages/home-connector/src/adapters/access-networks-unleashed/` and targets
controllers reachable from the local connector host through the Unleashed AJAX
management interface. The connector manages controllers locally through its
SQLite database:

- `access_networks_unleashed_scan_controllers` probes local private `/24`
  networks derived from the connector host's IPv4 interfaces, unless
  `ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS` overrides the scan list
- `access_networks_unleashed_adopt_controller` marks one discovered controller
  as the active controller for reads and writes
- `access_networks_unleashed_set_credentials` stores controller credentials
  locally, encrypted with `HOME_CONNECTOR_SHARED_SECRET`
- `ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS=true` allows connections when
  the controller uses a self-signed LAN certificate
- `ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS` can raise the default 8s
  request timeout for slower controllers or networks

Beyond controller lifecycle (scan/list/adopt/remove/credentials/authenticate),
the adapter exposes a single generic capability:

- `access_networks_unleashed_request` posts an authenticated XML payload to the
  adopted controller's `POST {host}/admin/_cmdstat.jsp` endpoint. It accepts
  `action` (`getstat` | `setconf` | `docmd`), `comp` (Unleashed component name
  such as `system`, `stamgr`, `apStat`, `eventd`), `xmlBody` (inner XML appended
  inside the `<ajax-request>` envelope), an optional `updater` string (defaults
  to `<comp>.<timestamp>.<rand>`), and an optional `allowInsecureTls` override.
  Responses are returned as both raw XML and a best-effort parsed object.

The capability is deliberately warning-heavy because `setconf` and `docmd`
actions can disconnect clients, take SSIDs offline, reboot access points, or
otherwise disrupt local connectivity. Each call requires:

- `acknowledgeHighRisk: true`
- an operator reason of at least 20 characters
- the exact confirmation phrase rejected for any other value

Higher-level Unleashed flows (list APs, list clients, edit WLANs, block clients,
restart APs, etc.) are intended to live in saved Kody packages that wrap
`home_access_networks_unleashed_request` through `kody:runtime`. The home
connector itself does not expose any typed Unleashed CLI or per-operation
capabilities.

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
- discovered Access Networks Unleashed controller metadata
- which Access Networks Unleashed controller is adopted
- Access Networks Unleashed credentials encrypted locally with
  `HOME_CONNECTOR_SHARED_SECRET`
- last Access Networks Unleashed authentication success/error details
- discovered Bond bridges and tokens
- discovered Sonos players
- managed Venstar thermostats

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
