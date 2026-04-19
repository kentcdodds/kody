# App task pattern: Cloudflare Developer Docs (`developers.cloudflare.com`)

Use this pattern when you need API or product documentation from
[developers.cloudflare.com](https://developers.cloudflare.com).

## Preferred approach

Use **markdown-preferred `fetch`** against a path under the docs site (see
allowlist below). Keep the skill focused on direct docs retrieval instead of
adding site-specific fallback machinery.

## Path allowlist

Paths must:

- Start with `/` and **must not** include a host.
- Start with one of:
  - `/api/`
  - `/fundamentals/`
  - `/workers/`
  - `/workers-ai/`
  - `/ai-gateway/`
  - `/d1/`
  - `/r2/`
  - `/kv/`
  - `/durable-objects/`
  - `/queues/`
  - `/vectorize/`
  - `/pages/`

- Not contain `..`, `#`, or whitespace; max length 2048.

## Example app task body

Adjust `name`, `title`, `description`, and trust flags when saving.

```javascript
;async () => {
	const ORIGIN = 'https://developers.cloudflare.com'
	const MARKDOWN_ACCEPT = 'text/markdown, text/plain;q=0.9, text/html;q=0.8'
	const PREFIXES = [
		'/api/',
		'/fundamentals/',
		'/workers/',
		'/workers-ai/',
		'/ai-gateway/',
		'/d1/',
		'/r2/',
		'/kv/',
		'/durable-objects/',
		'/queues/',
		'/vectorize/',
		'/pages/',
	]
	const assertAllowedPath = (path) => {
		const p = path.trim()
		if (!p.startsWith('/')) {
			throw new Error('path must start with / and must not include a host')
		}
		if (!PREFIXES.some((prefix) => p.startsWith(prefix))) {
			throw new Error(`path must start with one of: ${PREFIXES.join(', ')}`)
		}
		if (p.includes('..')) throw new Error('path must not contain ..')
		if (/[\s#]/.test(p)) throw new Error('path contains disallowed characters')
		if (p.length > 2048) throw new Error('path exceeds maximum length')
	}

	const path = '/api/resources/accounts/'
	assertAllowedPath(path)
	const url = new URL(path, ORIGIN).toString()
	const res = await fetch(url, { headers: { Accept: MARKDOWN_ACCEPT } })
	const body = await res.text()
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		markdownTokenEstimate: res.headers.get('x-markdown-tokens'),
		body: body.slice(0, 500_000),
	}
}
```

Callers should inspect `contentType` before treating `body` as Markdown. This
helper returns the raw sliced response body plus `markdownTokenEstimate`; HTML
responses are not auto-converted.

For parameterized app tasks, declare a task parameter (for example a required
`path` string) and read **`params.path`** instead of a hard-coded path.

## Related

- Tracking: [issue #120](https://github.com/kentcdodds/kody/issues/120) (broader
  official patterns folder).
