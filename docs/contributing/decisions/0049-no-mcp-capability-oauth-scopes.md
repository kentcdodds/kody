# 0049: No MCP capability OAuth scopes

- **Status:** accepted
- **Date:** 2026-09-04

## Context

`/oauth/authorize` listed requested OIDC scopes (`openid`, `profile`, `email`)
as if they were a permission menu. Those strings are live as identity claims:
`openid` enables ID tokens and UserInfo, `email` and `profile` add claims. MCP
does not consult them. A valid bearer token for this origin's `/mcp` audience
receives the full assistant (`search`, `execute`, secrets, packages, email,
memories, connected services).

Project intent does not optimize for fine-grained permission delegation inside
one account. Most MCP hosts request whatever discovery advertises and assume
full access.

## Decision

Do not add capability-level MCP OAuth scopes. Connecting an agent is one grant:
full access to that user's assistant.

Keep `openid`, `profile`, and `email` as OIDC identity claims.
`/oauth/authorize` describes the real grant in plain language and keeps those
scope names in a technical disclosure.

## Consequences

Consent copy must not look like a GitHub or Google picker. RFC 9728
`scopes_supported` remains the OIDC trio. Do not advertise a fake `mcp` or
`kody` resource scope until a revisit actually needs a second credential class.

**Revisit-if** a second class of MCP credential must be weaker than the owner's
assistant (for example a read-only host, or a token that cannot `execute`), and
that need cannot be met by a separate primitive (package-owned webhooks, package
apps).
