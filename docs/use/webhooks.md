# Inbound webhooks

Kody inbound webhooks are **package-centered**: you declare them in
`package.json#kody.webhooks`, mint a per-user credential URL, then point a
provider (Sentry, GitHub, Stripe, or any generic sender) at that URL. Each
delivery invokes the bound package export.

This is the HTTP sibling of [email primitives](./email-primitives.md). Webhooks
are the external HTTP knock: vendor providers (Sentry, GitHub, Stripe) and
first-party trusted clients (gateway proxies, CLIs) both POST to a minted URL.
[Package invocation bearer tokens](../contributing/package-invocation-api.md)
remain as an unadvertised drain; new callers use webhooks.

There is no `*` / multi-export URL. One declared webhook name binds one export.

Treat every minted URL as a **credential**. The URL secret is returned only on
mint/rotate and is never stored in plaintext.

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
- `replay` is optional. Without it, body-only HMAC is **replayable**: anyone who
  observes one legitimate signed delivery can POST it again. Opt in per webhook
  with a timestamp window and/or a unique delivery id. Trusted clients send
  `Idempotency-Key` instead of `replay.deliveryIdHeader`.

Declaring a webhook does **not** open ingress by itself.

## Mint the URL

Use the MCP `webhooks` domain:

1. Save/publish the package with `kody.webhooks`.
2. Store the HMAC secret with `secretSet` under the name used in
   `verification.secretName` (for example `sentryWebhookSecret`).
3. Call `webhookUrlMint` with the package id/kody id and `webhookName`.
4. Store the returned `url` immediately and paste it into the provider.

Other capabilities: `webhookList` (declarations joined with minted/enabled
state), `webhookUrlRotate`, `webhookEnable`, `webhookDisable`, and
`webhookDeliveryList` (metadata only; bodies are never stored). The same
delivery history also appears under [Activity](./activity.md)
(`/account/activity` and the `runs` capabilities).

## Ingress URL

`POST https://<origin>/@<username>/webhooks/<packageKodyId>/<webhookName>/<urlSecret>`

- Unknown / unminted / disabled / renamed-away / wrong secret → **404** (no
  distinction).
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
(`{ "params": { … }, "idempotencyKey": "…" }`), the platform unwraps `params`. A
top-level JSON object without a `params` object is the first argument as-is.
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
`webhookUrlRotate` when a credential may have leaked.

## Related

- Packages: [Packages](./packages.md)
- Architecture: [Inbound webhooks](../contributing/architecture/webhooks.md)
- Secrets: [Secrets and host approval](./secrets-and-values.md)
