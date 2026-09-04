# 0048 — Inbound HTTP is webhooks; invocation tokens drain

- **Status:** accepted
- **Date:** 2026-09-03

## Context

[0037](./0037-no-author-packages-invoke.md) kept HTTP invocation tokens
(`POST /@:user/api/package-invocations/…`) as the external knock after dropping
author-facing `packages.invoke`. First-party callers on the operator account
(Discord gateway, YouTube WebSub, Bluesky/LinkedIn launch, weekly-site-perf,
Raycast) still use those tokens. Inbound webhooks already cover vendor POST
(Sentry/Stripe/GitHub) with a URL secret and optional HMAC, but they did not
accept caller `Idempotency-Key`, pass JSON as the export first argument, or
allow a burst ceiling above ~60/min.

A second HTTP grant (`*` tokens, Bearer, invoke envelope) next to webhooks is
the values-shaped leftover: two knocks for one job. Webhooks already bind one
declared name to one export. There is no product need for a multi-export URL.

## Decision

Webhooks are the only advertised external HTTP knock. Invocation tokens become
an unadvertised drain after webhooks cover the invoke jobs (caller
`Idempotency-Key`, `inputMode: "params"`, configurable rate limit with a
documented max). Do not add `*` / multi-export webhook URLs. Do not delete token
tables, UI, or MCP token copy in the same change that makes webhooks capable.

The
[invocation-token retirement runbook](../architecture/invocation-token-retirement-runbook.md)
is the executable plan: values-style soak, then drop when leftover token rows
are 0.

## Consequences

Trusted clients mint a webhook URL, declare one webhook per export they call,
and POST JSON with `Idempotency-Key`. Vendor HMAC handlers stay on default
`inputMode: "request"`. Agents stop seeing invocation tokens as the way in once
the drain is unadvertised. Revisit only if a first-party caller cannot express
its invoke shape as one webhook per export plus the params/idempotency contract.

## LATER-NOTE (2026-09-04)

Token UI, MCP guides, `packageGet.tokens`, and setup URLs are unadvertised.
`packageInvocationTokenList` / `packageInvocationTokenGet` remain as an
unadvertised drain. The HTTP bearer path stays until leftover rows are 0. See
the
[invocation-token retirement runbook](../architecture/invocation-token-retirement-runbook.md).
