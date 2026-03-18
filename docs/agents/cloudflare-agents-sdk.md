# Cloudflare Agents SDK (`agents`)

This repo has the Cloudflare Agents SDK installed as the `agents` npm package.
It is designed for building long-lived, stateful "agent instances" on top of
Durable Objects (with built-in state, SQLite, WebSockets, queues, scheduling,
Workflows integration, MCP, and more).

Primary docs:

- https://developers.cloudflare.com/agents/

Installed in this repo as `agents` in `package.json` (currently `^0.7.4`).

## Quick pointers for this repo

- MCP server uses `McpAgent` in `mcp/index.ts` and is served via
  `MCP.serve(...)` in `worker/index.ts`.
- This project is not organized around the React hook APIs from the SDK; for
  non-React clients, use `AgentClient` from `agents/client`.

## Required configuration (Durable Objects + SQLite)

Agents require Durable Objects and (for persisted state) SQLite-backed storage.
Cloudflare's setup checklist lives here:

- https://developers.cloudflare.com/agents/api-reference/configuration/

## Docs map (what Cloudflare documents)

Use these sections when you want the official "how/why" and end-to-end guides:

- Getting started: https://developers.cloudflare.com/agents/getting-started/
- Concepts: https://developers.cloudflare.com/agents/concepts/
- Guides: https://developers.cloudflare.com/agents/guides/
- API reference: https://developers.cloudflare.com/agents/api-reference/
- MCP (Model Context Protocol):
  https://developers.cloudflare.com/agents/model-context-protocol/
- Platform notes (limits, prompting):
  https://developers.cloudflare.com/agents/platform/
- x402 payments: https://developers.cloudflare.com/agents/x402/

## SDK module map (what you can import)

These are the import paths exported by the installed `agents` package.

### Core server-side API

- `agents`
  - `Agent` base class (state, sqlite via `this.sql`, WebSockets via
    `onConnect`/`onMessage`, queue, scheduling, workflows, MCP client manager).
    Docs: https://developers.cloudflare.com/agents/api-reference/agents-api/
  - Routing helpers:
    - `routeAgentRequest(request, env, options?)` Docs:
      https://developers.cloudflare.com/agents/api-reference/routing/
    - `getAgentByName(namespace, name, options?)` Docs:
      https://developers.cloudflare.com/agents/api-reference/routing/#server-side-instance-selection
  - RPC/Callable helpers:
    - `@callable()` decorator Docs:
      https://developers.cloudflare.com/agents/api-reference/callable-methods/
    - `StreamingResponse` for streaming callables Docs:
      https://developers.cloudflare.com/agents/api-reference/callable-methods/#streaming-responses
  - `getCurrentAgent()` (access `{ agent, connection, request, email }`) Docs:
    https://developers.cloudflare.com/agents/api-reference/get-current-agent/
  - Email routing:
    - `routeAgentEmail(email, env, { resolver, ... })` Docs:
      https://developers.cloudflare.com/agents/api-reference/email/

### Client SDK (non-React friendly)

- `agents/client`
  - `AgentClient` (WebSocket client with state sync + RPC + streaming)
  - `agentFetch` (HTTP requests without WebSockets) Docs:
    https://developers.cloudflare.com/agents/api-reference/client-sdk/

### MCP (Model Context Protocol)

Use these if you're building MCP servers or connecting to external MCP servers.

- `agents/mcp`
  - `McpAgent` for stateful MCP servers on Durable Objects Docs:
    https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/
  - `createMcpHandler` and `WorkerTransport` for serving MCP without `McpAgent`
    (stateless or custom routing) Docs:
    https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/
- `agents/mcp/client`
  - `MCPClientManager` (connect/discover/list tools/prompts/resources across
    multiple MCP servers; persists connections in storage) Docs:
    https://developers.cloudflare.com/agents/api-reference/mcp-client-api/
- `agents/mcp/do-oauth-client-provider`
  - Durable Object-backed OAuth provider used for MCP client OAuth flows, and a
    customization point if you need a different OAuth strategy. Docs:
    https://developers.cloudflare.com/agents/guides/oauth-mcp-client/

### Workflows integration

- `agents/workflows`
  - `AgentWorkflow` base class for Cloudflare Workflows that need typed access
    back to their originating agent instance. Docs:
    https://developers.cloudflare.com/agents/api-reference/run-workflows/

### Scheduling prompt/schema helpers

- `agents/schedule`
  - `getSchedulePrompt` and `scheduleSchema` for parsing "natural language
    scheduling" input via an LLM (commonly with the AI SDK). Docs (agent
    scheduling itself):
    https://developers.cloudflare.com/agents/api-reference/schedule-tasks/

### Email helpers

- `agents/email`
  - Resolvers for inbound routing and secure reply routing (signature-based)
  - `isAutoReplyEmail` and signing helpers Docs:
    https://developers.cloudflare.com/agents/api-reference/email/

### Observability

- `agents/observability`
  - `Observability` interface + `genericObservability` Docs:
    https://developers.cloudflare.com/agents/api-reference/observability/

### Payments (x402)

- `agents/x402`
  - `withX402` (paid MCP tools) and `withX402Client` (call paid tools) Docs:
    https://developers.cloudflare.com/agents/x402/

### Optional UI/framework integrations

These exist, but you only need them if your UI stack wants them.

- `agents/react` (React state sync)
- `agents/ai-react` (React chat UI helpers)
- `agents/ai-chat-agent` (re-export of `@cloudflare/ai-chat`, including
  `AIChatAgent`) Docs for chat agents:
  https://developers.cloudflare.com/agents/getting-started/build-a-chat-agent/

## Capability outline (what the SDK enables)

Use this section when you want to answer "can Agents do X?" quickly.

### Durable, per-instance state + SQLite

- Persistent `this.state` with `initialState` and `this.setState(...)` that
  broadcasts to connected clients. Docs:
  https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/
- Embedded SQLite via `this.sql\`...\`` for relational data per agent instance.
  Docs:
  https://developers.cloudflare.com/agents/api-reference/agents-api/#sql-api

### Real-time communication (WebSockets) and streaming (HTTP/SSE)

- WebSocket lifecycle hooks (`onConnect`, `onMessage`, `onClose`, `onError`) and
  `this.broadcast(...)`. Docs:
  https://developers.cloudflare.com/agents/api-reference/websockets/
- HTTP request handling via `onRequest(request)`; SSE streaming patterns. Docs:
  https://developers.cloudflare.com/agents/api-reference/http-sse/

### RPC method calls from clients

- Mark methods with `@callable()` and call them from clients via:
  - `client.stub.someMethod(...)`
  - `client.call("methodName", [args])` Docs:
    https://developers.cloudflare.com/agents/api-reference/callable-methods/
- Streaming callables for token-by-token output using `StreamingResponse`. Docs:
  https://developers.cloudflare.com/agents/api-reference/callable-methods/#streaming-responses

### Access control: readonly connections

- Mark some connections as read-only to prevent state writes while still
  receiving state + calling read-only RPC methods. Docs:
  https://developers.cloudflare.com/agents/api-reference/readonly-connections/

### Background work: queues + schedules

- Queue tasks with `this.queue(...)` (async work stored in SQLite and processed
  FIFO). Docs:
  https://developers.cloudflare.com/agents/api-reference/queue-tasks/
- Schedule tasks with:
  - `this.schedule(delaySeconds | Date | cron, callbackName, payload?)`
  - `this.scheduleEvery(intervalSeconds, callbackName, payload?)` Docs:
    https://developers.cloudflare.com/agents/api-reference/schedule-tasks/

### Durable, multi-step execution: Workflows

- Run Cloudflare Workflows from an Agent (`this.runWorkflow(...)`) and handle
  progress/completion callbacks. Docs:
  https://developers.cloudflare.com/agents/api-reference/run-workflows/

### LLM integration (bring your model/provider)

The SDK does not force a single model provider. Common options in the docs:

- Workers AI bindings and streaming
- AI Gateway routing
- Vercel AI SDK (`ai`, `@ai-sdk/*`) for a unified provider interface

Docs: https://developers.cloudflare.com/agents/api-reference/using-ai-models/

### RAG, Vectorize, and web browsing

- Vector search with Vectorize + Workers AI embeddings to implement retrieval.
  Docs: https://developers.cloudflare.com/agents/api-reference/rag/
- Browser Rendering (or another headless browser service) for agent-driven web
  browsing. Docs:
  https://developers.cloudflare.com/agents/api-reference/browse-the-web/

### MCP (servers and clients)

- Build MCP servers on Durable Objects using `McpAgent`. Docs:
  https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/
- Serve MCP via `createMcpHandler` + `WorkerTransport`. Docs:
  https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/
- Connect to remote MCP servers as a client (OAuth, tools/resources/prompts).
  Docs: https://developers.cloudflare.com/agents/api-reference/mcp-client-api/

### Email routing

- Route inbound emails to specific agent instances; reply with
  `this.replyToEmail(...)`; secure reply routing via signature-based headers.
  Docs: https://developers.cloudflare.com/agents/api-reference/email/

### Platform limits + operational notes

- Limits (CPU time refresh behavior, state size, etc.) Docs:
  https://developers.cloudflare.com/agents/platform/limits/
