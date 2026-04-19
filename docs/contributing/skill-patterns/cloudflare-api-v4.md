# App task pattern: Cloudflare API v4 (`api.cloudflare.com`)

The **`cloudflare_rest`** builtin capability was removed. Use **secret-aware
`fetch`** in **`execute`** or an **app task** so Cloudflare API access can
change without shipping Worker code.

A reference app task named **`cloudflare-api-v4`** may already exist inside one
of your saved apps; otherwise save your own app task from the example below.

## Auth and hosts

- Base URL: `https://api.cloudflare.com` (or your account’s documented API
  hostname).
- Send `Authorization: Bearer {{secret:yourSecretName}}` (or with `|scope=user`
  / `app` / `session` as needed).
- The user must approve **`api.cloudflare.com`** for that secret (host approval
  in the account UI). Saving a secret does not approve hosts automatically.

Capability **allowlists** on secrets apply to **capability inputs** that use
`x-kody-secret`. Fetch-based access is primarily gated by **allowed hosts**.

## Paths

All API paths must be under **`/client/v4/`** (see
[Cloudflare API docs](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/)).

## Example app task

Use **`uses_capabilities`** or trust inference as appropriate. Mark
**`destructive: true`** when the skill can call mutating methods.

```javascript
;async () => {
	const path = '/client/v4/user/tokens/verify'
	const url = `https://api.cloudflare.com${path}`
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			Authorization: 'Bearer {{secret:cloudflareApiToken}}',
		},
	})
	const text = await res.text()
	let body = null
	if (text.trim()) {
		try {
			body = JSON.parse(text)
		} catch {
			throw new Error(`Cloudflare API returned non-JSON (${res.status})`)
		}
	}
	return { status: res.status, body }
}
```

For **POST / PUT / PATCH / DELETE**, set `Content-Type: application/json` and
`body: JSON.stringify(payload)`.

## Related

- Developer docs (read-only) pattern:
  [cloudflare-developer-docs.md](./cloudflare-developer-docs.md).
