# 0027: No invocation-token source allowlist

- **Status:** accepted
- **Date:** 2026-08-19

## Context

[0026](./0026-package-owned-invocation-tokens.md) kept a per-token source
allowlist after tokens became package-owned. The check was: omit or null
`source` always passes; a named `source` must be on `sources_json`. Empty lists
rejected every named label. That is not a client allowlist — a stolen bearer
that omits `source` still works — and the form field was hard to explain.

Production tokens all stored one caller label (`youtube-websub-proxy`,
`discord`, `raycast`, and the rest). Callers already send that string on the
request for logs. The token column added a second, weaker copy of the same name.

## Decision

Invocation tokens do not store or enforce a source allowlist. Request JSON
`source` remains an optional label for logs. Export allowlists stay. The 0026
package-ownership decision is unchanged.

## Consequences

`0019-drop-invocation-token-sources.sql` drops `sources_json`. Token create and
edit forms, MCP token metadata, and HTTP auth no longer mention allowed sources.
Agents may still send `source` on invoke; it is not required and does not fail
the call. Revisit only if a real caller-identity check is added that cannot be
omitted.
