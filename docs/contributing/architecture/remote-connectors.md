# Remote connectors

A **remote connector** is any service that opens an **outbound WebSocket** to
the Kody Worker and exposes **MCP-style tools** (`tools/list`, `tools/call`)
over that socket. The Worker’s remote connector session Durable Object
implementation holds one live session per **session key** and proxies Worker RPC
calls to JSON-RPC on the socket.

## URLs and session keys

`wss://<worker-origin>/@<username>/connectors/<kind>/<instanceId>`

Session key = JSON tuple `[userId, kind, instanceId]` where `kind` is lowercase
after trim.

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
   - **`sharedSecret`:** string — must match an enabled shared secret saved for
     the connector ref in D1.
   - **`connectorKind`:** non-empty string. Lowercase values are normalized.

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
should re-list tools when it supports dynamic registration.

## Internal access (DO RPC, not HTTP)

Worker-internal code that needs snapshot or tool data from a connector session
(such as `packages/worker/src/remote-connector/client.ts`) calls **Durable
Object RPC methods** directly on the stub — `getSnapshot()`, `rpcListTools()`,
`rpcCallTool()`, `forwardJsonRpc()`. These are plain method calls that never
pass through the DO's `fetch()` handler.

The DO's `fetch()` handler **only** accepts WebSocket upgrade requests. All
non-upgrade HTTP requests return `404`. The Worker entrypoint provides the first
layer of defense by rejecting non-WebSocket connector route requests before they
reach the DO; the DO `fetch()` handler provides the second layer.

External connector authors only need the **WebSocket**.

## Worker-side attachment (MCP caller context)

For capabilities to be synthesized from a connector, the MCP session must list
that connector:

- **`remoteConnectors`:** optional array of `{ kind, instanceId }`. When present
  (including empty), it fully defines the set of remote connectors for that
  session.

Regular authenticated MCP and chat sessions load this array from the user's
saved remote connector settings. Operators can manage those settings at
`/account/remote-connectors`:

- **`kind`** and **`instanceId`** identify the connector ref generically.
- **`enabled`** controls whether the saved shared secret can authenticate
  `connector.hello` for that ref.
- **`attached`** controls whether the ref is included in normal Kody MCP/chat
  caller context.
- **`sharedSecret`** is encrypted in D1 and authenticates only the user-scoped
  connector URL for the saved ref.

Source: `packages/shared/src/chat.ts`,
`packages/shared/src/remote-connectors.ts`, and
`packages/worker/src/remote-connector/settings-service.ts`.

## Capability naming (search / execute)

- The Worker uses distinct **domain ids** (for example
  `remote:<kind>:<instance>`) and **prefixed capability names** so nothing
  collides in `search` / `execute`.

## Connector checklist

1. **Outbound WebSocket** to your connector URL:
   `wss://<worker-origin>/@<username>/connectors/<kind>/<instanceId>`.
2. **Hello first** with matching **`connectorKind`** + **`connectorId`** and a
   **valid `sharedSecret`** for that `kind:instanceId` pair.
3. Implement **`tools/list`** and **`tools/call`** on the socket via
   **`connector.jsonrpc`** envelopes.
4. **Heartbeats** if the service stays connected for a long time.
5. **Operator config:** save the connector ref and shared secret from
   `/account/remote-connectors`; enabled + attached refs are loaded into normal
   Kody sessions so the registry merges your domain.

## Reference implementation

- Protocol types and parsing: `packages/worker/src/remote-connector/types.ts`,
  `packages/worker/src/remote-connector/utils.ts`
- Session Durable Object: `packages/worker/src/remote-connector/session.ts`
- Ingress and session key:
  `packages/worker/src/remote-connector/connector-session-key.ts`

## Related docs

- [Request lifecycle](./request-lifecycle.md) — where connector routes sit in
  the Worker.
