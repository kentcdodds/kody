# 0042 — No capability-input secret placeholders or capability allowlists

- **Status:** accepted
- **Date:** 2026-08-29

## Context

`x-kody-secret` let capability arguments accept `{{secret:name}}` placeholders.
`secret_entries.allowed_capabilities` was the default-deny allowlist for that
path (and for `secretJwtSign` looking up a key by name). The original consumer
was remote-connector credential handoff. Those connectors no longer synthesize
capabilities; home automation uses ordinary MCP servers.

MCP and OpenAPI still add runtime capabilities, but they do not opt fields into
`x-kody-secret`. Fetch placeholders already use `allowed_hosts`. Package code
already uses `allowed_packages`. Keeping a second plaintext-injection path plus
a per-capability policy invited agents to re-add connector-style secret inputs.

## Decision

Kody does not resolve secret placeholders in capability arguments and does not
keep a per-secret capability allowlist. Capabilities that need a saved secret
look it up by name (package access still applies) or tell the caller to use
execute-time `fetch(...)` placeholders so host approval remains the egress
boundary.

## Consequences

`secretJwtSign` signs with any secret the caller can resolve. `secretSet`
persists the raw `value` string; it does not expand `{{secret:…}}`. Host and
package grants stay. The fetch header `x-kody-secret-resolution: off` stays —
that is a different mechanism.

**Revisit-if** a first-party capability must accept saved-secret plaintext as an
argument without going through fetch, and host approval cannot cover that
handoff.
