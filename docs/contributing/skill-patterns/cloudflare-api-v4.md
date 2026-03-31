# Skill pattern: Cloudflare API v4 (`api.cloudflare.com`)

The **`cloudflare_rest`** builtin capability was removed. Use **secret-aware
`fetch`** in **`execute`** or a **saved skill** so Cloudflare API access can
change without shipping Worker code.

A reference saved skill named **`cloudflare-api-v4`** (collection **Cloudflare
Ops**) may already exist on your account; run it with
`meta_run_skill({ name: 'cloudflare-api-v4', params: { method, path, query?, body? } })`
or save your own copy from the example below.

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
The internal `CloudflareRestClient` used for Browser Rendering enforces the same
shape.

## Example skill (save via `meta_save_skill`)

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

- Browser Rendering billing path still uses the Worker’s internal client for
  `page_to_markdown` — that is unchanged.
- Developer docs (read-only) pattern:
  [cloudflare-developer-docs.md](./cloudflare-developer-docs.md).
