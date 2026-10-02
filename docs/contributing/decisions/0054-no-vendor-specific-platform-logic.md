# 0054 — No vendor-specific platform logic

- **Status:** accepted
- **Date:** 2026-10-01

## Context

Platform surfaces (webhook challenges, verification knobs, capabilities, package
contracts) kept growing short vendor-named forks — `meta-hub`, `strava-hub`,
`slack-url-verification`, and similar — when a third-party handshake differed by
a content-type or JSON key. Each fork trains the next agent to add `foo-hub`
instead of extending a generic primitive. That fights the product shape: Kody
owns generic capabilities; packages and manifests configure them for a provider
through params and options.

## Decision

Do **not** add vendor- or service-specific types, handlers, branches, or
capability names in the Kody platform (worker, MCP registry, authored
`package.json#kody.*` schema that the platform owns). Capabilities stay generic.
Third-party services configure them via params/options and documented presets —
never via named forks like `strava-hub` or `meta-hub`.

Refuse new `*-hub`, `*-crc`, or provider-branded challenge/verification type
ids. Prefer one knobby primitive (arrival, proof, response). The same bar
applies outside webhooks: no `stripeFoo` platform capability when a generic form
with options covers it.

## Consequences

Webhook subscription challenges use only `subscription-challenge` with knobs.
Former vendor-named type ids (`meta-hub`, `strava-hub`, `x-activity-crc`,
`websub-hub`, `slack-url-verification`) are rejected at parse time — packages
must declare the matching documented preset. Docs show provider presets as
config examples, not as schema enums to extend. Existing vendor-shaped leftovers
(for example a timestamp format enum value) are migrated when touched — do not
use them as precedent for new forks.

**Revisit-if** a provider handshake cannot be expressed as knobs on an existing
generic primitive without inventing an unsafe open-ended interpreter, and the
need is durable across many packages (not one shim).
