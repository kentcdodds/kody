# 0055: CLI MCP OAuth may authenticate local-execute HTTP only

- **Status:** accepted
- **Date:** 2026-10-01
- **Amends:** [0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md)

## Context

[0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md) kept scoped
`kody_at_` API tokens as the only HTTP credential for the Open API and
CapabilityProxy, and said the CLI must not scavenge **host** MCP OAuth for Open
API calls. Product later asked for `npx @kodycodes/cli execute --local` to work
after `kody login` without minting a temporary API token. The CLI already sends
its own stored login access token as `Authorization: Bearer` when no
`KODY_API_TOKEN` is set
([kody-bot/cli#14](https://github.com/kody-bot/cli/pull/14)). Live probes
returned `401 Invalid API token` for non-`kody_at_` bearers — a credential-class
rejection, not a missing scope.

## Decision

Accept a valid **CLI** MCP OAuth access token (SEP-991 client id
`${appOrigin}/oauth/cli-client-metadata.json`, same class as `/mcp`) as Bearer
on these local-execute HTTP surfaces only:

- `GET /v1/capability-proxy/session`
- `POST /v1/capability-proxy/call`
- `POST /v1/local-execute/package-graph`

Semantics:

1. `kody_at_…` keep today's API-token path (scopes + idle TTL).
2. Else a valid CLI MCP OAuth access token for this app origin (grant `clientId`
   must be the official CLI CIMD URL) authenticates as that user with the **full
   MCP grant** for those routes; still require the `local-execute` feature flag.
   Skip API-token scope checks (OIDC `openid`/`profile`/`email` are not
   capability scopes — [0049](./0049-no-mcp-capability-oauth-scopes.md)).
3. Else 401 as today.

Do **not** accept MCP OAuth from other clients (Cursor, ChatGPT, …) on these
routes. Do **not** accept MCP OAuth on other Open API routes. Do **not** accept
`kody_at_` on `/mcp`. Do **not** require a `tokenCreate` exchange for the
login-backed path. Host MCP OAuth from other clients is still out of scope; only
the CLI's own `kody login` store is used on the client.

## Consequences

- Open API general operations stay `kody_at_`-only (0053's core split holds).
- Local execute can use either credential; the flag is the kill switch for both.
- **Amended by [0056](./0056-cli-credential-bootstrap.md):** agents on MCP that
  cannot run interactive `kody login` use `cliCredentialBootstrap` → CLI redeem
  instead of a second OAuth or chat-facing `tokenCreate`.
- Revisit if a weaker-than-owner MCP session is needed beyond API tokens, or if
  OAuth should expand beyond local-execute HTTP.
