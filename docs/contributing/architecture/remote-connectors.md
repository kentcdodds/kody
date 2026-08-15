# Remote connectors

A **remote connector** is any service that opens an **outbound WebSocket** to
the Kody Worker and exposes **MCP-style tools** (`tools/list`, `tools/call`)
over that socket. The Worker’s remote connector session Durable Object
implementation holds one live session per **session key** and proxies Worker RPC
calls to JSON-RPC on the socket.

## URLs and session keys

`wss://<worker-origin>/@<username>/connectors/<instanceId>`

Session key = JSON tuple `[userId, instanceId]` where `instanceId` is the
user-chosen connector name, lowercase after trim.

The Worker sets header **`X-Kody-Connector-Session-Key`** on requests forwarded
into the Durable Object. The connector’s **`connector.hello`** must declare a
**`connectorId`** (instance id) that matches the session key implied by the
WebSocket URL; otherwise the session closes with a mismatch error.

## WebSocket message protocol

All messages are **JSON objects** with a **`type`** field.

### Client → Worker (connector)

1. **`connector.hello`** (required first logical message after open)
   - **`type`:** `"connector.hello"`
   - **`connectorId`:** string — the explicit user-chosen connector name
     (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, for example `home` or
     `living-room`). Connector names are globally unique per user.
   - **`sharedSecret`:** string — must match an enabled shared secret saved for
     the connector in D1.
   - **`connectorKind`:** ignored by Kody (optional; connector-kit clients may
     send it).

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
  content, `isError`, etc.). When execute returns that capability result
  directly, protocol-valid non-text content blocks (images, audio, resources)
  pass through to the upstream MCP client; see
  [Raw MCP content blocks](../../use/raw-content-blocks.md).

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

- **`remoteConnectors`:** optional array of `{ instanceId }`, where `instanceId`
  is the explicit connector name. When present (including empty), it fully
  defines the set of remote connectors for that session.

Regular authenticated MCP and chat sessions load this array from the user's
saved remote connector settings. Background package runtimes do the same:
package apps (when the runtime bridge builds caller context for capabilities or
nested `packages.invoke`), package services, subscription handlers, jobs,
workflows, HTTP invocation tokens, and webhook delivery. Hosted app serve
(`servePackageAppRequest`) does not load remotes on the warm path; the runtime
bridge loads them when user code needs capabilities.

Operators can manage those settings at `/account/remote-connectors`:

- **`instanceId`** is the user-chosen connector name. Names are unique per user
  and key `kody.remote[name]`.
- **`enabled`** controls whether the saved shared secret can authenticate
  `connector.hello` for that connector.
- **`attached`** controls whether the connector is included in normal Kody
  MCP/chat caller context.
- **`sharedSecret`** is encrypted in D1 and authenticates only the user-scoped
  connector URL for the saved name.

Source: `packages/shared/src/chat.ts`,
`packages/shared/src/remote-connectors.ts`, and
`packages/worker/src/remote-connector/settings-service.ts`.

## Capability naming (search / execute)

- The Worker uses distinct **domain ids** (for example `remote:<name>`) and
  remote capability **entity ids** of the form `remote:<name>:<tool>`.
- In execute/runtime code, remote connector tools are visibly separate from
  built-ins: use `kody.remote["<name>"].<tool>(input)`. Built-ins remain flat
  (`kody.value_get(...)`), but remote tools are never exposed as flat
  `kody.<kind>_<instance>_<tool>` functions.
- Search capability detail returns the exact remote call snippet. If a connector
  is missing, disconnected, or exposes a different tool list, the `kody.remote`
  Proxy throws an error listing available connectors or kody.

## Connector checklist

1. **Outbound WebSocket** to your connector URL:
   `wss://<worker-origin>/@<username>/connectors/<connectorName>`.
2. **Hello first** with matching **`connectorId`** and a **valid
   `sharedSecret`** for that connector name.
3. Implement **`tools/list`** and **`tools/call`** on the socket via
   **`connector.jsonrpc`** envelopes.
4. **Heartbeats** if the service stays connected for a long time.
5. **Operator config:** save the connector and shared secret from
   `/account/remote-connectors`; enabled + attached connectors are loaded into
   normal Kody sessions so the registry merges your domain.

## Reference implementation

- Protocol types and parsing: `packages/worker/src/remote-connector/types.ts`,
  `packages/worker/src/remote-connector/utils.ts`
- Session Durable Object: `packages/worker/src/remote-connector/session.ts`
- Ingress and session key:
  `packages/worker/src/remote-connector/connector-session-key.ts`

## Related docs

- [Request lifecycle](./request-lifecycle.md) — where connector routes sit in
  the Worker.
