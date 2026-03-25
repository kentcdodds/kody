# Home Connector

The local `packages/home-connector` process is the bridge between Kody's
Cloudflare Worker and devices that are only reachable on the local network.

## Current adapters

The connector currently exposes two local-device families:

- Roku discovery and control over SSDP + ECP HTTP
- Samsung TV / Frame discovery and control over mDNS, REST, and local WebSocket
  channels

Both surfaces are registered as MCP tools inside the connector and then exposed
to the Worker through the existing outbound WebSocket session to
`HomeConnectorSession`.

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

The adapter does not currently promise:

- full installed-app enumeration
- named app launch for apps without a known app ID
- guaranteed full power off/on semantics across Frame firmware variants

Power support is intentionally split:

- power off uses the Samsung local remote channel with `KEY_POWEROFF`
- power on uses Wake-on-LAN and the TV's stored MAC address

This works well enough to expose as a connector capability, but it should still
be treated as best-effort because Samsung Frame firmware can blur the line
between Art Mode and true standby.

## Local persistence

Unlike the Worker-side home connector session, which persists its own view of
the live socket state in Durable Object storage, the local connector now also
persists Samsung-specific state on disk.

The connector stores a local SQLite database containing:

- discovered Samsung TV metadata
- whether each TV has been adopted
- the latest pairing token for each TV
- last token verification / auth error details

By default the database is stored at
`~/.kody/home-connector/home-connector.sqlite`. Operators can override the base
directory with `HOME_CONNECTOR_DATA_PATH` or the full file path with
`HOME_CONNECTOR_DB_PATH`.

This persistence is intentionally local to the connector host so that pairing
survives connector restarts without pushing device-local secrets into Worker
storage.

## Discovery and mocks

Samsung discovery defaults to `mdns://_samsungmsf._tcp.local`. The current live
implementation shells out to `dns-sd`, which makes local scanning primarily a
macOS-focused workflow unless an explicit discovery URL is provided.

In local development with `MOCKS=true`, the connector uses mock Samsung TV
handlers in the same style as the Roku mocks:

- mock discovery endpoint
- mock device metadata
- mock app status and app launch
- mock pairing/token issuance
- mock remote-key behavior
- mock power state transitions
- mock Art Mode state transitions

That lets the adapter, MCP surface, and admin routes run in local development
and tests without needing a physical Samsung TV.
