# 0013: Synthetic package requests for post-publish verification

- **Status:** accepted
- **Date:** 2026-08-08

## Context

Saved packages expose several runtime surfaces — exports, apps, subscriptions,
services, jobs, and webhooks — but post-publish verification paths were uneven.
`packages.invoke` covers export smoke tests in the package runtime (including
secret mounts), yet package apps required a browser session handoff to the
hosted origin, and subscription handlers could only be exercised by waiting for
real platform events (inbound mail, repo pushes, run failures, and so on).
Agents authoring packages over MCP need an owner-scoped way to invoke app fetch
handlers and subscription handlers immediately after publish without external
triggers or UI automation.

Alternatives considered and rejected:

- **Signed app URL.** Mint a short-lived signed URL that hits the public app
  mount without a browser session. Rejected: signed app URLs create a new
  leakable credential surface bypassing the login gate.
- **Real inbox injection.** Store a fixture message in the user's inbox and wait
  for production `email.message.received` dispatch. Rejected: injecting
  synthetic messages into the real inbox pollutes real mail
  storage/classification.

## Decision

Add two MCP capabilities under the `packages` domain. Both are **platform-marked
real-surface invocations**: they run the same `app_fetch` and `subscription`
surfaces as production traffic with normal package context, `packageStorage()`,
and secret mounts. **Side effects are real** — synthetic calls write storage,
call outbound APIs, and enqueue downstream work like any other handler run.

The platform **exclusively sets and strips trust markers**. Public app ingress
strips caller-supplied `Kody-Synthetic` from requests; real event dispatch
strips caller-supplied `synthetic` and `replay_of` from handler envelopes.
Synthetic MCP calls set the markers; callers cannot forge them.

- **`package_app_fetch`** — invoke a published package app's fetch handler with
  method, path, headers, and body. The platform sets request header
  `Kody-Synthetic: true` before the handler runs. Returns exactly
  `{ status, headers, body, truncated }`; binary response bodies are base64.
  Rejects websocket upgrade requests.
- **`package_subscription_dispatch`** — invoke one declared subscription handler
  on one saved package. Accepts exactly one of `params` or `email_message_id`
  (not both). The platform sets top-level envelope fields `synthetic: true` and,
  for stored-mail replay, `replay_of`. Replay rebuilds the stored inbound email
  envelope from D1. There is **no caller `idempotency_key`** — the platform
  generates internal idempotency keys. Targets only the named package; it does
  not fan out platform events or enqueue production Queue delivery.

Run records for both surfaces include the same synthetic markers the handler
payload carries. Handlers treat synthetic invocations identically to production
unless a deliberately visible irreversible-side-effect guard says otherwise.

Successful `package_publish_external_push` responses include `test_hints` when
the package declares an app and/or subscriptions: copy-pasteable capability
calls agents can run before treating the publish complete.

## Consequences

- Post-publish verification stays on the compact MCP surface; no browser-run or
  preview-URL primitive is added (see
  [0008](./0008-declined-adlc-primitives.md)).
- Synthetic app fetches do not replace hosted-URL checks for UI, cookies, OAuth
  redirect flows, or websocket facets — they prove handler/runtime wiring only.
- Synthetic subscription dispatch validates handler code and manifest wiring for
  one package; it does not substitute for end-to-end tests of Queue delivery,
  admin-role gates, or multi-subscriber fan-out.
- `app_fetch` synthetic requests remain excluded from package activation
  milestones, matching public HTTP traffic.
- Authors who smoke-test handlers with real side effects should use fixture
  inputs or a deliberately visible irreversible-side-effect guard — the platform
  does not simulate or sandbox package side effects.
- Revisit only if agents routinely need synthetic calls into services, jobs, or
  webhooks — those surfaces stay on their existing invoke or ingress paths for
  now.
