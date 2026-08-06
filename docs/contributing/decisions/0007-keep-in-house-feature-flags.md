# 0007: Keep in-house feature flags; revisit Flagship at GA

- **Status:** accepted
- **Date:** 2026-08-05

## Context

Cloudflare Flagship (public beta since 2026-05) is a native feature flag service
built on OpenFeature: flags evaluate through a Workers binding inside the
isolate with config distributed via KV/DO, and it offers targeting rules,
consistent-hash percentage rollouts, typed variants, a field-level audit trail,
and dashboard management. Kody's `feature-flags` primitive
(`packages/worker/src/feature-flags/`) is a code-registry design: flags are
declared in code (reviewable in PRs), state lives in D1, with rollouts and
per-user overrides. Flagship covers everything the in-house system does and adds
consistent-hash rollouts and dashboard toggling without a deploy.

## Decision

Do not migrate to Flagship now. It is a public beta with unannounced pricing;
dashboard-managed flags would invert the repo's code-as-source-of-truth
convention for flag definitions; and the local-dev/test story (deterministic
flags in `npm run validate`, Wrangler simulation of the binding) is unverified.

Separately decided: packages do not get a feature-flag primitive of their own —
per-user isolation removes the point of gradual rollout for personal software.

## Consequences

- The in-house registry stays the flag system; no new capability work needed.
- The preferred hedge, when convenient: put the OpenFeature interface in front
  of the existing D1-backed flags as a thin adapter. It changes no behavior and
  makes a later provider swap a configuration change — OpenFeature's explicit
  design goal.
- Revisit at Flagship GA, when pricing is known and the Wrangler local-dev and
  deterministic-test stories can be verified.
