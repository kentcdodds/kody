# Inbound webhooks

Kody inbound webhooks are **package-centered**: you declare them in
`package.json#kody.webhooks`, mint an opaque handle with `webhookUrlMint`, then
register the credential with `webhookUrlApply` (generic HTTPS, including the
GitHub Hooks API) or copy the URL yourself from the package's
[settings page](#manage-webhook-urls-in-package-settings). MCP and execute never
return the credential URL or `url_secret`. Each delivery invokes the bound
package export.

This is the HTTP sibling of [email primitives](./email-primitives.md). Webhooks
are the external HTTP knock: vendor providers (Sentry, GitHub, Stripe) and
first-party trusted clients (gateway proxies, CLIs) both POST to a minted URL.
[Package invocation bearer tokens](../contributing/package-invocation-api.md)
are an unadvertised drain; new callers use webhooks.

There is no `*` / multi-export URL. One declared webhook name binds one export.

Treat every minted URL as a **credential**. Mint and rotate return an opaque
`handle` (and `url_host`), never the URL or `url_secret`. Register the URL with
`webhookUrlApply` so the credential stays inside Kody, or open the package's
[settings page](#manage-webhook-urls-in-package-settings) and copy it yourself
for providers without an apply adapter. MCP and execute never return the URL;
the owner does that from package settings.

## Declare a webhook in the package manifest

```json
{
	"name": "@you/sentry-bridge",
	"exports": {
		"./handle-sentry-webhook": "./src/handle-sentry-webhook.ts"
	},
	"kody": {
		"id": "sentry-bridge",
		"description": "Forward Sentry webhooks into automations",
		"webhooks": [
			{
				"name": "sentry",
				"export": "./handle-sentry-webhook",
				"responseMode": "ack",
				"verification": {
					"type": "hmac-sha256",
					"header": "sentry-hook-signature",
					"secretName": "sentryWebhookSecret",
					"encoding": "hex"
				}
			}
		]
	}
}
```

Rules:

- `name` is a slug unique within the package.
- `export` must reference a declared `package.json#exports` entry (validated at
  save/publish). One webhook name ↔ one export. There is no wildcard export.
- `responseMode` is `ack` (default) or `sync`.
- `inputMode` is `request` (default) or `params`. Vendor handlers stay on
  `request`. First-party trusted clients that send invoke-shaped JSON use
  `params` (see [Trusted clients](#trusted-clients)).
- `rateLimitPerMinute` is optional. Default **60**. Maximum **600** (gateway
  fan-in). A leaked URL is still bounded; there is no unlimited setting.
- `verification.secretName` references a **named secret in your secret store** —
  never an inline secret value. The platform resolves it at delivery time; if
  the secret is missing, the delivery is rejected and logged. First-party
  trusted clients omit `verification` and rely on the URL secret.
- `verification.signedPayload` is `'body'` (default) or `'timestamp.body'`. Use
  `'timestamp.body'` when the provider HMAC covers
  `` `${timestamp}.${rawBody}` ``.
- `challenge` is optional. When set, the platform answers the provider's
  ownership quiz on the **same minted URL** (GET CRC / hub challenge, or Slack
  `url_verification` POST) without invoking your export. See
  [Subscription challenges](#subscription-challenges).
- `replay` is optional. Without it, body-only HMAC is **replayable**: anyone who
  observes one legitimate signed delivery can POST it again. Opt in per webhook
  with a timestamp window and/or a unique delivery id. Trusted clients send
  `Idempotency-Key` instead of `replay.deliveryIdHeader`.

Declaring a webhook does **not** open ingress by itself.

## Mint a handle

Use the MCP `webhooks` domain:

1. Save/publish the package with `kody.webhooks`.
2. Store the HMAC secret with `secretSet` under the name used in
   `verification.secretName` (for example `sentryWebhookSecret`).
3. Call `webhookUrlMint` with the scoped package name (or `package_id` when the
   name is not known) and `webhookName`.
4. Call `webhookUrlApply` with the returned `handle` and a `type: "http"`
   destination. Kody POSTs/PUTs the minted URL into any HTTPS registration
   endpoint via `{{webhookUrl}}` substitution (for example GitHub's
   `POST /repos/{owner}/{repo}/hooks`). The owner can copy the URL from the
   package's [settings page](#manage-webhook-urls-in-package-settings)
   (`/@<username>/<packageKodyId>/settings#webhooks`) when that is simpler.

Other capabilities: `webhookList` (declarations joined with minted handle /
enabled state), `webhookUrlRotate`, `webhookEnable`, `webhookDisable`,
`webhookDeliveryList` (metadata only; bodies are never stored), and
`webhookSyntheticDispatch` (interactive-MCP smoke test for a minted webhook —
see [Synthetic smoke test](#synthetic-smoke-test)). The same delivery history
also appears under [Activity](./activity.md) (`/account/activity` and the `runs`
capabilities). List, mint, rotate, apply, and synthetic dispatch never return
the credential URL.

## Manage webhook URLs in package settings

Webhooks belong to the package that declares them, so the signed-in owner
manages their URLs on that package's settings page:
`/@<username>/<packageKodyId>/settings`, **Webhooks** section (for example
`/@kentcdodds/raycast/settings#webhooks`). The section lists every webhook the
package declares, joined with its minted state, one card per webhook:

- **Mint URL** issues the first credential for a declared webhook and shows the
  URL once so you can paste it into the provider.
- **Reveal URL** shows a minted URL again, with a copy button. Each reveal is
  written to the account audit log.
- **Rotate URL** replaces the secret. The previous URL stays active for **24
  hours**, or until the first accepted delivery arrives on the new URL. Rerun
  `webhookUrlApply` (same handle) or paste the new URL into the provider. The
  card shows “Previous URL active until …” during that overlap.
- **Disable** / **Enable** toggle ingress without deleting the mint. Disabled
  webhooks answer 404.

The URL is the human path. Agents get the handle and `url_host` through MCP and
either apply the handle (`type: "http"`) or ask the owner to copy the URL from
package settings. Mints that predate encrypted secret storage cannot be shown;
the card offers Rotate for those.

`/account/webhooks` (account rail → Webhooks) is a read-only index of every
webhook across your packages. Each row links to the owning package's Webhooks
section; nothing is minted or revealed from the index.

### Apply a handle to a destination

`webhookUrlApply` resolves the handle inside Kody and registers the URL through
an outbound HTTPS request (`type: "http"`). The model never sees the secret:
Kody injects the minted URL server-side via `{{webhookUrl}}` and returns only
`{ ok, url_host, http_status, remote_id, error }`. Remote bodies that echo the
hook URL are redacted.

Owner rationale: the signed-in owner can already reveal and paste the URL from
package settings. Opaque apply exists so agents can register that same
credential without pulling plaintext into model context — including at
caller-chosen HTTPS endpoints. Settings reveal/paste is owner consent. Silent
model-chosen apply to an arbitrary URL is not: prompt injection could POST the
long-lived credential to an attacker endpoint. Generic `http` therefore requires
an interactive hard confirm that surfaces the exact destination before the
outbound request runs.

Generic HTTPS (`type: "http"`) — Kody sends the request and substitutes
`{{webhookUrl}}` into `url`, header values, and/or `body` (form bodies are
decoded/re-encoded). The placeholder is required. Destination URLs must be
`https://`. Redirects are not followed. Auth is optional via `secretName` or
`integration` (Bearer), or a caller-supplied `Authorization` header — not both.

That path is **interactive MCP only** and reuses the same **account owner
approval flow** as secret host approval (`/connect/secrets`), secret package
grants, and locked-package publish approval: the capability returns an
`approval_url` to `/connect/webhook-apply` with the exact method, URL,
`{{webhookUrl}}` injection sites, headers, body template, and auth mode. The
signed-in owner Allows on the website (writing a durable destination grant); the
agent then retries and the outbound request runs. Package runtimes cannot use
`http` apply. Agents never grant access and never see the webhook credential.

```ts
await kody.webhooks.webhookUrlApply({
	handle,
	destination: {
		type: 'http',
		url: 'https://hooks.example/register',
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{"webhookUrl":"{{webhookUrl}}"}',
		secretName: 'hooksRegistrationToken',
	},
})
// If approval is required, send the owner approval_url (/connect/webhook-apply),
// wait for Allow, then retry the same call.
```

GitHub repository hooks use the same `http` path against the Hooks API
(`POST https://api.github.com/repos/{owner}/{repo}/hooks`). Put `{{webhookUrl}}`
in `config.url`, send the GitHub Accept / API-Version headers, and authorize
with `integration: 'github'` (or a host-approved token via `secretName`). Apply
substitutes only `{{webhookUrl}}` — it does **not** inject named secrets into
the body. Destination `secretName` / `integration` authorize the outbound
request as Bearer; they are not GitHub's hook signing secret.

If the package webhook declares HMAC `verification.secretName`, GitHub must also
have that same value as the hook's `config.secret` so deliveries include a valid
`x-hub-signature-256`. Set it in the GitHub UI after revealing the URL from
[package settings](#manage-webhook-urls-in-package-settings), or create the hook
from a package export that resolves the named secret server-side. Do not put the
signing secret in the apply `body` template (that would put it in model
context).

```ts
await kody.webhooks.webhookUrlApply({
	handle,
	destination: {
		type: 'http',
		url: 'https://api.github.com/repos/acme/api/hooks',
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({
			name: 'web',
			active: true,
			events: ['push', 'pull_request'],
			config: {
				url: '{{webhookUrl}}',
				content_type: 'json',
				insecure_ssl: '0',
				// Omit config.secret here. For HMAC verification, set the hook
				// secret in GitHub to the same value as verification.secretName.
			},
		}),
		integration: 'github',
	},
})
```

Prefer `http` for Workers and any provider API that accepts a callback URL
field. Providers that need an ownership quiz (X Activity CRC, WebSub / YouTube,
Meta, Slack URL verification) use a declared
[`challenge`](#subscription-challenges) on the webhook — you do not need a shim
Worker for those. Do not invent per-vendor apply adapters when a single HTTPS
registration request is enough. The owner can also reveal and paste the URL from
package settings.

## Ingress URL

`GET|POST https://<origin>/@<username>/webhooks/<packageKodyId>/<webhookName>/<urlSecret>`

- Unknown / unminted / disabled / renamed-away / wrong secret → **404** (no
  distinction).
- `GET` is allowed only when the webhook declares a GET-capable
  [`challenge`](#subscription-challenges); otherwise **405**.
- Payload > **1 MB** → **413**.
- Rate limit per minted webhook → **429**. Default **60**/min; override with
  `rateLimitPerMinute` up to **600**.
- `ack`: **202** `{ "ok": true }` after Kody durably queues the delivery; the
  export runs in the background. Bodies use the same **1 MB** cap as sync;
  oversized queue messages spill to ephemeral storage until the consumer runs. A
  temporary queue failure returns **503** so the provider can retry without Kody
  claiming acceptance.
- `sync`: waits for the export JSON result (**502** on failure).

Background delivery retries keep the same idempotency key, so a transient
platform persistence failure does not duplicate a completed export. Package
exports still have the normal execution limit (about 90 seconds); packages that
exceed it receive an explicit timeout failure and should split or checkpoint
their work.

## Subscription challenges

Some providers prove URL ownership with a fixed quiz before they send events:
HMAC a `crc_token`, echo a hub challenge, or return a Slack `challenge`. Kody
answers those on the minted webhook URL **in the platform** — the bound export
never runs for the quiz, and challenge handling does not mutate account state,
call MCP, or fetch outbound.

Declare one `challenge` object next to (or instead of, when the provider has no
POST HMAC) `verification`:

| `challenge.type`         | Method                                         | What the platform does                                     | `secretName`                                            |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `x-activity-crc`         | GET `crc_token`                                | JSON `{ response_token: "sha256=" + base64(HMAC-SHA256) }` | **Required** (X consumer secret)                        |
| `websub-hub`             | GET `hub.mode` + `hub.challenge`               | Echo challenge as `text/plain`                             | Optional; when set, `hub.verify_token` must match       |
| `meta-hub`               | GET `hub.mode=subscribe` + `hub.challenge`     | Echo challenge as `text/plain` after verify-token match    | **Required** (Meta verify token)                        |
| `slack-url-verification` | POST `{ type: "url_verification", challenge }` | JSON `{ challenge }`                                       | Optional; when set, Slack signing signature must verify |

`secretName` is the same named secret-store reference as
`verification.secretName` — never an inline value. Later vendor POSTs still go
through normal URL-secret + optional HMAC verification; only verified deliveries
reach the export.

### X Activity (CRC) example for `@kentcdodds/x`

```json
{
	"name": "activity-event",
	"export": "./activity-event",
	"challenge": {
		"type": "x-activity-crc",
		"secretName": "xConsumerSecret"
	},
	"verification": {
		"type": "hmac-sha256",
		"header": "X-Twitter-Webhooks-Signature",
		"secretName": "xConsumerSecret",
		"encoding": "base64",
		"prefix": "sha256="
	}
}
```

Store the X consumer secret with `secretSet` under `xConsumerSecret`, mint the
webhook, then register the revealed URL directly with X. CRC GETs never invoke
`./activity-event`; activity POSTs do, after HMAC verification.

### Meta hub example

```json
{
	"name": "meta-webhook",
	"export": "./handle-meta",
	"challenge": {
		"type": "meta-hub",
		"secretName": "metaVerifyToken"
	}
}
```

### Slack Events example

```json
{
	"name": "slack-events",
	"export": "./handle-slack-event",
	"challenge": {
		"type": "slack-url-verification",
		"secretName": "slackSigningSecret"
	}
}
```

When `challenge.secretName` is set, the platform verifies Slack's
`X-Slack-Signature` on the quiz POST (`` `v0:${timestamp}:${body}` ``) before
echoing. Event POSTs still use the normal delivery path — declare a matching
`verification` block when those deliveries must also verify Slack signing (the
URL secret alone is enough only for trusted setups that omit HMAC).

## Payload shape seen by the package export

```ts
{
	webhook: {
		packageKodyId: string
		name: string
		receivedAt: string // ISO timestamp
	}
	request: {
		method: string
		contentType: string | null
		headers: Record<string, string> // safe allowlisted subset, lowercase keys
		body: string // raw text
		json: unknown | null
	}
}
```

Example export:

```js
export async function handleSentryWebhook(input) {
	const event = input.request.json
	// ... automate ...
	return { ok: true }
}
```

## Signature verification examples

### Sentry

```json
{
	"type": "hmac-sha256",
	"header": "sentry-hook-signature",
	"secretName": "sentryWebhookSecret",
	"encoding": "hex"
}
```

### GitHub

```json
{
	"type": "hmac-sha256",
	"header": "x-hub-signature-256",
	"secretName": "githubWebhookSecret",
	"encoding": "hex",
	"prefix": "sha256="
}
```

GitHub HMAC covers the raw body only. Add `replay.deliveryIdHeader` so a
replayed `X-GitHub-Delivery` is acknowledged without running the export again:

```json
{
	"name": "github",
	"export": "./handle-github-webhook",
	"verification": {
		"type": "hmac-sha256",
		"header": "x-hub-signature-256",
		"secretName": "githubWebhookSecret",
		"encoding": "hex",
		"prefix": "sha256="
	},
	"replay": {
		"deliveryIdHeader": "X-GitHub-Delivery"
	}
}
```

### Stripe

Stripe signs `` `${t}.${rawBody}` `` and sends both the unix timestamp and HMAC
in `Stripe-Signature`. Declare `signedPayload: "timestamp.body"` and a timestamp
window:

```json
{
	"name": "stripe",
	"export": "./handle-stripe-webhook",
	"verification": {
		"type": "hmac-sha256",
		"header": "Stripe-Signature",
		"secretName": "stripeWebhookSecret",
		"encoding": "hex",
		"signedPayload": "timestamp.body"
	},
	"replay": {
		"timestampHeader": "Stripe-Signature",
		"timestampFormat": "stripe-signature",
		"toleranceSeconds": 300
	}
}
```

`stripe-signature` reads `t=<unix>` from the header. Deliveries whose timestamp
is missing, unparseable, or older than `toleranceSeconds` (default 300) are
rejected with the same generic 401 as a bad HMAC.

## Synthetic smoke test

After mint, smoke-test the bound export from **interactive MCP** with
`webhookSyntheticDispatch` instead of POSTing a real provider delivery to
yourself. Search the `webhooks` domain, then call:

```json
{
	"kodyId": "@you/sentry-bridge",
	"webhookName": "sentry",
	"request": {
		"json": { "action": "created" }
	}
}
```

For `inputMode: "params"` webhooks, pass `params` (the first-arg object) instead
of `request`. The platform skips the public URL and HMAC path, marks the
Activity webhook run `synthetic: true`, and counts the invoke against automation
usage like a normal delivery. **Side effects are real.** The capability is
owner-only and unavailable from package jobs, subscriptions, webhooks, or other
package runtimes. It never returns `url` / `url_secret`.

Do not confuse platform synthetic dispatch with a package-local `dryRun` field
on trusted-client POSTs — those are unrelated contracts. Sibling fields such as
`route` and `dryRun` on `params`-mode fixtures are preserved for the export; the
platform only sets top-level `synthetic: true`.

## Trusted clients

A first-party caller (Discord gateway proxy, YouTube WebSub worker, Raycast
extension, social-launch client) mints a webhook URL and POSTs JSON. No
`Authorization: Bearer`. One webhook per export they actually call.

```json
{
	"name": "message-created",
	"export": "./dispatch-message-created",
	"responseMode": "sync",
	"inputMode": "params",
	"rateLimitPerMinute": 600
}
```

Use `sync` when the caller needs the export JSON (or a **409** idempotency
conflict). Use `ack` when the caller only needs acceptance; the queue consumer
applies the same idempotency ledger.

`inputMode: "params"` passes a JSON object as the export's **first argument**,
matching invocation-token `params`. If the body is the invoke envelope
(`{ "params": { … } }` with optional `idempotencyKey`, `source`, and `topic`),
the platform unwraps `params`. `idempotencyKey` counts only as a non-empty
string, and `source` / `topic` only as a string or null. A top-level JSON object
that is not that envelope is the first argument as-is, so sibling fields such as
`route` and `dryRun` stay visible even when a nested `params` object is present.
Arrays and non-objects are **400** `invalid_params`. Default
`inputMode: "request"` is unchanged: the export still receives
`{ webhook, request }`.

Send **`Idempotency-Key`** (standard header). In `params` mode, JSON
`idempotencyKey` is accepted when the header is absent. Same key + same payload
replays the stored result. On `sync`, a different payload is **409**
`idempotency_mismatch` and an in-progress key is **409**
`invocation_in_progress`. `ack` still returns **202** after enqueue; the
consumer records the ledger outcome. This works without HMAC — the URL secret is
the credential.

Caller keys use the same package-invocation idempotency ledger as
`replay.deliveryIdHeader`. Delivery-id keys still match by id alone (vendor
retries change `receivedAt`). Caller keys hash the payload: in `params` mode
that is the export first argument; in `request` mode it is the JSON body so
`receivedAt` does not break retries.

Do not declare a `*` webhook. A client that calls several exports gets one
webhook declaration per export.

## Lifecycle

Republishing a package that removes or renames a webhook deactivates that
ingress (unknown name → 404). Disable with `webhookDisable` without deleting the
mint; re-enable with `webhookEnable`. Rotate the URL secret with
`webhookUrlRotate` when a credential may have leaked, then call
`webhookUrlApply` again with the same handle so providers get the new URL. The
[settings card](#manage-webhook-urls-in-package-settings) describes the 24-hour
/ first-accepted-delivery overlap. The same disable, enable, and rotate actions
are in that Webhooks section.

## Related

- Packages: [Packages](./packages.md)
- Architecture: [Inbound webhooks](../contributing/architecture/webhooks.md)
- Secrets: [Secrets and host approval](./secrets-and-values.md)
