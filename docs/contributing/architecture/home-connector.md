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
- Island router diagnostics over SSH using a typed command allowlist plus a tiny
  opt-in set of high-risk write operations
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
itself to typed allowlisted SSH operations from the connector host to the local
router. The default posture is read-only diagnostics. A tiny set of mutating
operations is available only when the connector runtime explicitly opts in, SSH
host verification is configured, and the caller supplies strict per-operation
acknowledgements. It is designed for situations where Kody only has network
reachability to the router from the NAS or other machine running the home
connector.

The adapter does expose:

- router identity/status via `show version`, `show clock`, `show system`, and
  `show interface summary`
- router-side reachability checks with `ping`
- ARP / neighbor-cache inspection with `show ip neighbors`
- DHCP reservation inspection with `show ip dhcp-reservations`
- recent-event lookups with `show log`
- structured WAN/failover, routing, NAT, VLAN, DNS, user, firewall/security,
  QoS, traffic, session, VPN, DHCP-server, NTP, syslog, SNMP, and
  system/bandwidth reads from a typed SSH CLI allowlist that now prefers the
  Island-documented `show system`/`show stats`, `show hardware`,
  `show running-config`, `show vpns`, `show ip sockets`, and
  `show ntp status|associations` families over unsupported guessed top-level
  subcommands
- a structured `router_diagnose_host` workflow that combines ping, ARP,
  reservation, interface, and log data for one host
- a broader but still typed and explicitly allowlisted high-risk write surface
  for failover selection, DHCP reservations, reboot, interface descriptions, DNS
  servers, host blocking/unblocking, `clear dhcp-client`, `clear log`, and
  `write memory` when all write guardrails pass

The adapter explicitly does not expose:

- arbitrary shell or CLI command execution over MCP
- arbitrary mutating router commands beyond the typed allowlist
- password-based auth flows through MCP

The write-capable operations are intentionally hard to use because mistakes can
have severe consequences. Agents must be highly certain before using them. The
MCP surface requires:

- SSH host verification via `known_hosts` or a pinned host fingerprint
- typed tool-specific inputs instead of free-form CLI
- an operator reason and an exact acknowledgement phrase per operation
- destructive tool annotations and warning-heavy descriptions

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
management interface. Configure it with:

- `ACCESS_NETWORKS_UNLEASHED_HOST`
- `ACCESS_NETWORKS_UNLEASHED_USERNAME`
- `ACCESS_NETWORKS_UNLEASHED_PASSWORD`
- `ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS=false` when the controller uses
  a certificate trusted by the connector host. The default allows self-signed
  LAN certificates.
- `ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS` when the default 8s request
  timeout is too short.

The adapter exposes read-only tools for controller status, access point
inventory, active clients, WLAN/SSID configuration, and recent events. It also
exposes a small typed write surface for client block/unblock, WLAN
enable/disable, AP restart, and AP LED visibility changes.

The write tools are deliberately warning-heavy. Each requires:

- `acknowledgeHighRisk: true`
- an operator reason
- an exact operation-specific confirmation phrase

The adapter does not expose arbitrary Unleashed CLI or arbitrary AJAX payload
execution.

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
