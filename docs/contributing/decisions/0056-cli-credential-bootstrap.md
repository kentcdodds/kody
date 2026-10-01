# 0056: Explicit MCP/API session → CLI credential bootstrap

- **Status:** accepted
- **Date:** 2026-10-01
- **Amends:** [0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md),
  [0055](./0055-cli-mcp-oauth-local-execute-http.md)

## Context

[0055](./0055-cli-mcp-oauth-local-execute-http.md) lets interactive `kody login`
MCP OAuth authenticate CapabilityProxy and package-graph. Agents already
connected to Kody over MCP still faced a second interactive OAuth (or a
`tokenCreate` that returns `kody_at_…` into chat-facing tool text) before
`npx @kodycodes/cli execute --local` worked without `KODY_API_TOKEN`.

[0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md) forbids scavenging
**host** MCP OAuth into the CLI. The missing piece is an **explicit**
session→CLI handoff that does not paste long-lived secrets into chat.

## Decision

One credential-bootstrap primitive, dual-exposed:

1. **Capability + Open API** `cliCredentialBootstrap`
   (`kody.cliCredentialBootstrap` / `POST /v1/tokens/bootstrap`, scope
   `tokens:write`) — authenticated by the current MCP session or an eligible API
   token. Returns a one-shot `kody_bc_…` bootstrap code + `cli_command`. Never
   returns `kody_at_…`.
2. **Native Open API** `cliCredentialBootstrapRedeem`
   (`POST /v1/tokens/bootstrap/redeem`) — code-authenticated only (no Bearer).
   Burns the code and mints a normal scoped `kody_at_…` for the CLI to store.
   Rejected for the MCP `api` tool principal so redeem cannot dump secrets into
   chat.

Default eventual scopes: `local-execute` + `account:read`. Token parents cannot
escalate scopes or outlive their own `max_expires_at`. `tokenCreate` remains for
CI/headless and power users. Interactive humans who already ran `kody login`
skip bootstrap (0055).

Do **not** add OAuth device flow. Do **not** accept bootstrap codes as general
Open API Bearers. Do **not** scavenge host MCP tokens from disk.

## Consequences

- New D1 table `cli_credential_bootstrap_codes` (hash + TTL + one-shot).
- `api_tokens.created_via` gains `cli-bootstrap`.
- HTTP handler allows one unauthenticated route (redeem), rate-limited at the
  API edge by IP.
- CLI companion: `npx @kodycodes/cli auth bootstrap --code …` redeems and stores
  the API token for `--local`.
- Agent tips prefer bootstrap (or login) over `tokenCreate` for interactive
  local execute.
