# Remote connectors

A **remote connector** is any service that opens an **outbound WebSocket** to
the Kody Worker and exposes **MCP-style tools** (`tools/list`, `tools/call`)
over that socket. The Worker’s `HomeConnectorSession` Durable Object (binding
name `HOME_CONNECTOR_SESSION`) holds one live session per **session key** and
proxies HTTP `fetch` from Worker code to JSON-RPC on the socket.

The first shipped connector is **`packages/home-connector`** (`kind: home`).
Additional kinds use the same protocol and routing pattern described below.

## URLs and session keys

- **Home (legacy URL, still supported):**  
  `wss://<worker-origin>/home/connectors/<instanceId>`  
  Session key = `<instanceId>` (unchanged from historical behavior).

- **Generic:**  
  `wss://<worker-origin>/connectors/<kind>/<instanceId>`  
  Session key = `<kind>:<instanceId>` when `kind` is not `home` (lowercase
  compared after trim).

The Worker sets header **`X-Kody-Connector-Session-Key`** on requests forwarded
into the Durable Object. The connector’s **`connector.hello`** must declare a
**`connectorKind`** and **`connectorId`** (instance id) that match the session
key implied by the WebSocket URL; otherwise the session closes with a mismatch
error.

## WebSocket message protocol

All messages are **JSON objects** with a **`type`** field.

### Client → Worker (connector)

1. **`connector.hello`** (required first logical message after open)
   - **`type`:** `"connector.hello"`
   - **`connectorId`:** string — instance id (for example `default`,
     `living-room`).
   - **`sharedSecret`:** string — must match Worker configuration (see
     [Environment variables](../environment-variables.md#remote-connector-secrets)).
   - **`connectorKind`:** string (optional but **required for generic
     `/connectors/...` URLs**). Omit or set to `"home"` for the home connector.
     Lowercase values are normalized.

2. **`connector.heartbeat`**
   - **`type`:** `"connector.heartbeat"`
   - Keeps `lastSeenAt` fresh in the session DO.

3. **`connector.jsonrpc`**
   - **`type`:** `"connector.jsonrpc"`
   - **`message`:** a single JSON-RPC 2.0 object (request or response).

### Worker → Client (connector process)

- **`server.ping`** — Worker may send this; connector should stay connected.
- **`server.ack`** — Successful hello; includes **`connectorId`** echo.
- **`server.error`** — Human-readable **`message`**; connection may close.

## JSON-RPC on the socket

The Worker sends MCP-style requests over the WebSocket wrapped in
`connector.jsonrpc`:

- **`tools/list`** — Return `{ tools: [...] }` where each tool has at least
  **`name`**, and typically **`description`**, **`inputSchema`**, optional
  **`title`**, **`outputSchema`**, **`annotations`** (same shape as MCP tools).

- **`tools/call`** — Params: `{ name: string, arguments?: object }`. Return a
  normal MCP **`CallToolResult`**-compatible payload (content, structured
  content, `isError`, etc.).

If the Worker forwards **`notifications/tools/list_changed`**, the connector
should re-list tools when it supports dynamic registration. Separately, the
reference implementation in `packages/home-connector` **proactively** sends
`notifications/tools/list_changed` **to** the Worker right after
**`server.ack`** so the session performs an initial tool snapshot refresh.

## HTTP helper endpoints (same origin)

The same Durable Object serves snapshot and RPC helpers on paths **under the
connector URL** (for example `/snapshot`, `/rpc/tools-list`). External connector
authors normally only need the **WebSocket**; Worker-internal code uses these
for bridging.

## Worker-side attachment (MCP caller context)

For capabilities to be synthesized from a connector, the MCP session must list
that connector:

- **`remoteConnectors`:** optional array of `{ kind, instanceId }`. When present
  (including empty), it fully defines the set of remote connectors for that
  session.
- **`homeConnectorId`:** when `remoteConnectors` is omitted, a non-null value
  maps to `{ kind: "home", instanceId: homeConnectorId }`.

Source: `packages/shared/src/chat.ts`,
`packages/shared/src/remote-connectors.ts`.

## Capability naming (search / execute)

- Single **`home`** connector with instance id **`default`:** synthesized
  capabilities stay on the builtin **`home`** domain with names like
  **`home_<tool>`** (legacy stability).

- Any other combination (multiple home instances, non-`home` kinds): the Worker
  uses distinct **domain ids** (for example `remote:<kind>:<instance>`) and
  **prefixed capability names** so nothing collides in `search` / `execute`.

## Compatibility checklist

1. **Outbound WebSocket** to the correct path for your **`kind`** and
   **`instanceId`**.
2. **Hello first** with matching **`connectorKind`** + **`connectorId`** and a
   **valid `sharedSecret`** for that `kind:instanceId` pair.
3. Implement **`tools/list`** and **`tools/call`** on the socket via
   **`connector.jsonrpc`** envelopes.
4. **Heartbeats** if the service stays connected for a long time.
5. **Operator config:** Worker `REMOTE_CONNECTOR_SECRETS` and/or
   `HOME_CONNECTOR_SHARED_SECRET` for `home`; MCP clients must pass
   **`remoteConnectors`** / **`homeConnectorId`** so the registry merges your
   domain.

## Reference implementation

- Protocol types and parsing: `packages/worker/src/home/types.ts`,
  `packages/worker/src/home/utils.ts`
- Session Durable Object: `packages/worker/src/home/session.ts`
- Ingress and session key:
  `packages/worker/src/remote-connector/connector-session-key.ts`
- Home connector WebSocket client:
  `packages/home-connector/src/transport/worker-connector.ts`

## Related docs

- [Home Connector](./home-connector.md) — the shipped `home` implementation
  (Roku, Lutron, Samsung TV, Sonos).
- [Request lifecycle](./request-lifecycle.md) — where connector routes sit in
  the Worker.
- [Environment variables](../environment-variables.md#remote-connector-secrets)
  — secrets and optional JSON map.
