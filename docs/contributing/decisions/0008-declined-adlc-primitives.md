# 0008: Declined ADLC primitives (traces, previews, browser runs, session mining)

- **Status:** accepted
- **Date:** 2026-08-05

## Context

Cloudflare's Agent Development Lifecycle launch (2026-08) shipped a set of
primitives aimed at agent-run "software factories": OpenTelemetry traces in
local dev, Agent Traces, preview URLs, Browser Run, Flagship, and gradual
deployments. Several map plausibly onto Kody, so each was evaluated against
project intent (personal software, per-user isolation, compact MCP surface). CI
is covered by [0006](./0006-no-repo-ci-primitive.md) and feature flags by
[0007](./0007-keep-in-house-feature-flags.md).

## Decision

Decline the following as Kody primitives:

- **Span-level traces for user code.** OTel-in-dev is aimed at local
  development, which is separate from what Kody runs; run records
  (`packages/worker/src/run-records/`) remain the execution-history and
  debugging surface.
- **Package previews (preview URLs).** Personal software does not need a preview
  lane: a user who wants to try a change first can fork their own repo and
  publish the fork. No compelling use cases identified.
- **Browser runs as a primitive.** Programmable headless browsers would explode
  cost and complexity; the capability can be built as a package if wanted, and
  most users reach Kody from an agent host that already has browser tooling.
- **Gradual deployments for packages.** Per-user isolation means each user's
  package serves only them; percentage ramps have no population to ramp over.
- **Session-trace self-improvement.** Mining Kody's own MCP sessions to update
  memories or guides is not a good fit for a change; it also carries the highest
  privacy sensitivity of the set.

## Consequences

- Run records stay the single observability surface for user code; no new trace
  storage or query domain.
- "Preview before publish" stays a user-space pattern (fork and publish) rather
  than a platform lane.
- Browser automation, if demand appears, arrives as a community or personal
  package — not a capability domain — keeping the MCP surface compact.
- Any future revisit of these should start from a concrete user need, not from
  platform availability of the underlying Cloudflare product.
