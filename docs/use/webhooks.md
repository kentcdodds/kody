# Inbound webhooks

Kody inbound webhooks are **package-centered**: you declare them in
`package.json#kody.webhooks`, mint a per-user credential URL, then point a
provider (Sentry, GitHub, Stripe, or any generic sender) at that URL. Each
delivery invokes the bound package export.

This is the HTTP sibling of [email primitives](./email-primitives.md). Unlike
[package invocation bearer tokens](../contributing/package-invocation-api.md),
webhook URLs work with providers that cannot set custom `Authorization` headers.

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
  save/publish).
- `responseMode` is `ack` (default) or `sync`.
- `verification.secretName` references a **named secret in your secret store** —
  never an inline secret value. The platform resolves it at delivery time; if
  the secret is missing, the delivery is rejected and logged.

Declaring a webhook does **not** open ingress by itself.

## Mint the URL

Use the MCP `webhooks` domain:

1. Save/publish the package with `kody.webhooks`.
2. Store the HMAC secret with `secret_set` under the name used in
   `verification.secretName` (for example `sentryWebhookSecret`).
3. Call `webhook_url_mint` with the package id/kody id and `webhookName`.
4. Store the returned `url` immediately and paste it into the provider.

Other capabilities: `webhook_list` (declarations joined with minted/enabled
state), `webhook_url_rotate`, `webhook_enable`, `webhook_disable`, and
`webhook_delivery_list` (metadata only; bodies are never stored). The same
delivery history also appears under [Activity](./activity.md)
(`/account/activity` and the `runs` capabilities).

## Ingress URL

`POST https://<origin>/@<username>/webhooks/<packageKodyId>/<webhookName>/<urlSecret>`

- Unknown / unminted / disabled / renamed-away / wrong secret → **404** (no
  distinction).
- Payload > **1 MB** → **413**.
- About **60 requests/minute** per minted webhook → **429**.
- `ack`: **202** `{ "ok": true }` after Kody durably queues the delivery; the
  export runs in the background. A temporary queue failure returns **503** so
  the provider can retry without Kody claiming acceptance. Ack deliveries must
  fit the queue-safe serialized limit (about **120 KB**); larger authenticated
  payloads return **413**.
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

## Lifecycle

Republishing a package that removes or renames a webhook deactivates that
ingress (unknown name → 404). Disable with `webhook_disable` without deleting
the mint; re-enable with `webhook_enable`. Rotate the URL secret with
`webhook_url_rotate` when a credential may have leaked.

## Related

- Packages: [Packages](./packages.md)
- Architecture: [Inbound webhooks](../contributing/architecture/webhooks.md)
- Secrets: [Secrets, values, and host approval](./secrets-and-values.md)
