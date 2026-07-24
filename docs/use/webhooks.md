# Inbound webhook endpoints

Kody gives each user **inbound webhook endpoints**: HTTPS URLs that third-party
services can POST to (Sentry, GitHub, Stripe, or any generic sender). Each
endpoint is bound to one of your saved-package exports. When a delivery arrives,
Kody verifies optional signatures, then invokes that export with a structured
payload.

This is the HTTP sibling of [email primitives](./email-primitives.md):
user-owned ingress that dispatches into your automations. Package-invocation
bearer tokens are a different surface — many providers cannot set custom
`Authorization` headers, which is why webhook endpoints embed a URL secret
instead.

Treat every endpoint URL as a **credential**. The URL secret is returned only
when you create or rotate an endpoint; it is never stored in plaintext and
cannot be retrieved later.

## Create an endpoint

Use the MCP `webhooks` domain:

1. Save a package that exports a handler (for example `./handle-webhook`).
2. Call `webhook_endpoint_create` with a name, the package id or kody id, and
   `exportName`. Optionally set `responseMode` (`ack` default, or `sync`) and
   `verification` for HMAC signature checks.
3. Store the returned `url` immediately (it includes the one-time URL secret).
4. Paste that URL into the provider's webhook settings.

Other capabilities: `webhook_endpoint_list`, `webhook_endpoint_get` (no
secrets), `webhook_endpoint_update` (enable/disable, rename, rebind export,
set/clear verification), `webhook_endpoint_rotate_secret` (new URL once),
`webhook_endpoint_delete`, and `webhook_delivery_list` (recent delivery
metadata; bodies are never stored).

## Wire a provider

Point the provider at:

`POST https://<origin>/@<username>/webhooks/<endpointId>/<urlSecret>`

- Unknown ids, disabled endpoints, username mismatches, and wrong URL secrets
  all return **404** (no distinction).
- Payloads larger than **1 MB** return **413**.
- Endpoints are rate-limited to about **60 requests/minute**; excess returns
  **429**.
- `responseMode: ack` responds **202** `{ "ok": true }` immediately and runs the
  export in the background.
- `responseMode: sync` waits for the export and returns its JSON result (**502**
  on invocation failure).

## Payload shape seen by the package export

The bound export receives one object argument:

```ts
{
	webhook: {
		endpointId: string
		name: string
		receivedAt: string // ISO timestamp
	}
	request: {
		method: string
		contentType: string | null
		headers: Record<string, string> // safe allowlisted subset, lowercase keys
		body: string // raw text
		json: unknown | null // parsed JSON when the body is valid JSON
	}
}
```

Example handler:

```js
export async function handleWebhook(input) {
	const event = input.request.json
	// ... automate ...
	return { ok: true }
}
```

## Signature verification

When `verification` is set on the endpoint, Kody computes an HMAC over the **raw
request body** and compares it (constant-time) to the named header. Mismatch or
a missing header returns **401**. The verification secret is encrypted at rest
with the same secret-store key used by the secrets primitive.

### Sentry

```json
{
	"type": "hmac-sha256",
	"header": "sentry-hook-signature",
	"secret": "<client-secret-from-sentry>",
	"encoding": "hex"
}
```

### GitHub

```json
{
	"type": "hmac-sha256",
	"header": "x-hub-signature-256",
	"secret": "<webhook-secret>",
	"encoding": "hex",
	"prefix": "sha256="
}
```

Stripe-style providers typically use `hmac-sha256`, header `stripe-signature`,
and their own signed-payload format — for Stripe's timestamped scheme you may
still want a thin package export that validates the Stripe-specific header shape
after Kody's generic HMAC check, or skip Kody verification and validate inside
the export.

## Related

- Architecture: [Inbound webhooks](../contributing/architecture/webhooks.md)
- Packages: [Packages](./packages.md)
- Bearer-token invocations (different surface):
  [Package invocation API](../contributing/package-invocation-api.md)
