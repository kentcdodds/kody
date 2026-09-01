# OpenAI Apps / ChatGPT plugin submission

Operator runbook for preparing and demonstrating Kody as an OpenAI Apps /
ChatGPT Developer Mode MCP connector. This page does **not** submit the OpenAI
form and does **not** claim production deploy status for sibling PRs.

Related work outside this page:

- Search retriever closed-world hardening ships separately (see the open search
  safety PR). Do not treat that branch as production until it merges and
  deploys.
- Domain verification, MCP annotation regression tests, and this runbook live in
  the submission-readiness change.

## Prerequisites

- Production origin: `https://kody.codes` (MCP URL `https://kody.codes/mcp`).
- A disposable Kody account with a **verified** email. Do not use a production
  operator account for demo mutations.
- ChatGPT on an eligible paid plan with Developer mode enabled
  ([connect notes](../use/connect-your-agent.md)).
- App icon: `/images/kody-app-icon.png` (256×256, under ChatGPT's 10 KB limit).
- Search-runtime closed-world fix **and** this submission-readiness change are
  both deployed before portal submit (portal already authenticated and scanned
  `search` + `execute`).

## Domain verification

`GET https://kody.codes/.well-known/openai-apps-challenge` must return the
current OpenAI portal token as unauthenticated `text/plain` (Worker-first
discovery route; token constant in
`packages/worker/src/app/agent-discovery.ts`).

```bash
curl -sS -D - -o /tmp/openai-apps-challenge.out \
  'https://kody.codes/.well-known/openai-apps-challenge'
# Expect: HTTP 200, Content-Type: text/plain; charset=utf-8,
# no WWW-Authenticate / Location, body exactly the portal token (no trailing
# newline).
```

Rotate by updating `openaiAppsChallengeToken` and redeploying. The value is
public (not a Worker secret).

## MCP surface contract

Production MCP exposes exactly two tools with these annotations:

| Tool      | readOnly | destructive | openWorld | idempotent |
| --------- | -------- | ----------- | --------- | ---------- |
| `search`  | true     | false       | false     | true       |
| `execute` | false    | true        | true      | false      |

Regression coverage: `mcp-tool-annotations.node.test.ts`,
`mcp-auth.workers.test.ts` (`tools/list`), and `stateless-lane.mcp-e2e.test.ts`.
OAuth (CIMD + PKCE + verified-email gate) stays required for `/mcp`.

## OpenID Connect gap

OpenAI reports enterprise domain restrictions as unavailable because Kody does
not advertise OpenID Connect. That warning is **not** a submission blocker.

**What exists today**

- OAuth 2.1 authorization server via `@cloudflare/workers-oauth-provider`
- Discovery: `/.well-known/oauth-authorization-server`
- Protected resource metadata: `/.well-known/oauth-protected-resource` (+
  `/mcp`)
- Scopes: `profile`, `email` only (no `openid`)
- ChatGPT CIMD authorize + token exchange covered in
  `oauth-handlers.workers.test.ts`
- Access/refresh tokens carry grant props (`userId`, `email`, `username`,
  `displayName`); email must be verified before approve / MCP

**What is missing for OIDC OP compliance**

- `/.well-known/openid-configuration`
- `openid` (and typically `email`) scope advertisement as OIDC scopes
- Signed `id_token` (JWT) issuance
- Standards-shaped UserInfo endpoint returning a verified email claim (OAuth
  `/api/me` is not UserInfo)

**Why not fake it in this PR**

Advertising OIDC discovery without real ID tokens and UserInfo would mislead
hosts and enlarge the auth attack surface. The Workers OAuth provider is an
OAuth AS, not a full OP. Adding OIDC needs a deliberate design: JWT signing
keys, issuer/audience rules, refresh/rotation, claim mapping from verified
account email, and client migration for hosts that still request
`profile email`.

**Follow-up recommendation**

1. Inventory whether `@cloudflare/workers-oauth-provider` (or a thin layer on
   top) can mint ID tokens and UserInfo without forking grant storage.
2. If yes, add `openid` additively, publish OIDC discovery beside AS metadata,
   mint `id_token` on code exchange when `openid` is granted, and expose
   UserInfo that returns verified email from the same account gate MCP uses.
3. If not, schedule a tracked auth project (new issuer keys, claim contract,
   host matrix) rather than bolting discovery-only stubs.
4. Keep ChatGPT CIMD + `profile email` working unchanged during any rollout.

## Developer Mode demo recording

Record in ChatGPT Developer mode with Kody connected. Use a fresh chat per case
unless the case needs a follow-up. Keep the tool-call panel visible.

### Prove search is side-effect-free

Before case 1 and after any case that might have mutated state:

1. Note account activity / memories / packages counts (or use a clean disposable
   account).
2. Ask ChatGPT to run several `search` queries only (capabilities, guides,
   packages) and refuse `execute`.
3. Confirm no new memories, packages, jobs, webhooks, or activity rows appeared.
4. Optionally repeat the same `search` and show identical tool results.

### Case 1 — Read-only capability discovery

**Prompt:** “Using only Kody `search`, list capabilities for sending email and
show me the detail for one hit. Do not call `execute`.”

**Expected tool calls:** one or more `search` (`query` / `domain` / `entity`);
no `execute`.

**Expected state:** no durable writes. Annotations on the listed `search` tool
remain read-only / closed-world.

**Cleanup:** none.

### Case 2 — Portable preference memory after conflict checking

**Prompt:** “Remember that I prefer metric units in summaries. Use Kody memory:
verify first, then upsert only if nothing conflicts.”

**Expected tool calls:** `search` (optional discovery) → `execute` with
`metaMemoryVerify` → `execute` with `metaMemoryUpsert` (category `preference`)
only after reviewing verify results.

**Expected state:** one preference memory visible from Account → Memories and
from a second host or a new ChatGPT chat via `search`/`memoryContext`.

**Cleanup:** soft-delete the demo memory (`metaMemoryDelete`) or delete from
`/account/memories`.

### Case 3 — Private user-owned package creation

**Prompt:** “Create a private Kody package that returns
`{ ok: true, demo: 'openai-submission' }` from a default export. Keep it private
(not a community publish).”

**Expected tool calls:** `search` for package authoring guidance as needed →
`execute` with `packageSave` (or git remote + publish). Manifest stays owner-
private (no community publish approval).

**Expected state:** package appears under Account → Packages for that user only;
`search` can find it for the owner.

**Cleanup:** `packageDelete` with matching `confirm_name`, or delete from the
account UI.

### Case 4 — Weekday scheduled execution without another model call

**Prompt:** “Author a private package with a weekday cron job (Mon–Fri) whose
scheduled entry writes a small marker into `packageStorage()` and returns it.
Enable the schedule only after you test the no-arg wrapper via `execute`. Then
show that the job runs on the schedule without me asking the model again.”

**Expected tool calls:** package authoring `execute`s; test call importing the
scheduled wrapper; job enabled via manifest publish and/or `jobUpdate`. Later
proof is Account → Jobs / Activity (or `jobRunNow` once for a forced run),
**without** a new ChatGPT turn driving each tick.

**Expected state:** package-owned job with weekday schedule; run history shows
platform-scheduled (or `jobRunNow`) execution writing storage.

**Cleanup:** disable/delete the job and package after recording.

### Case 5 — Webhook-triggered package storage without a third-party

integration

**Prompt:** “Create a private package with an inbound webhook that stores the
JSON body under `packageStorage()`. Mint the webhook URL, then show a curl POST
to that URL (no Stripe/GitHub/Sentry app). Confirm storage updated.”

**Expected tool calls:** package save with `kody.webhooks` → `webhookUrlMint` →
operator `curl` to
`/@{username}/webhooks/{packageKodyId}/{webhookName}/{urlSecret}` →
`search`/`execute` read-back of storage (or Account activity).

**Expected state:** webhook delivery run recorded; package storage holds the
payload. No third-party OAuth integration required.

**Cleanup:** `webhookDisable` or delete the package; treat the minted URL as a
credential (do not commit it).

## Cleanup checklist

After the recording session:

1. Delete demo memories, packages, jobs, and webhooks.
2. Revoke any extra MCP OAuth clients created only for the demo.
3. Confirm the disposable account has no leftover scheduled jobs enabled.

## Manual production checks before portal submit

1. Domain challenge curl (above) matches the portal token.
2. ChatGPT Plugins scan still shows only `search` and `execute` with the
   annotation table above.
3. Search-runtime closed-world PR is merged **and** deployed (do not submit on
   annotations alone if retrievers can still write).
4. Optional: re-run focused local gates —
   `npm run test -- packages/worker/src/app/handlers/agent-discovery.node.test.ts packages/worker/src/mcp/tools/mcp-tool-annotations.node.test.ts packages/worker/src/mcp-auth.workers.test.ts`
   and `npm run validate` when touching shared surfaces.
