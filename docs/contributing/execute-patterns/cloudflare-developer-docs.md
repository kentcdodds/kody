# Package/execute pattern: Cloudflare Developer Docs (`developers.cloudflare.com`)

Use this pattern when you need API or product documentation from
[developers.cloudflare.com](https://developers.cloudflare.com).

## Preferred approach

Use **markdown-preferred `fetch`** against a path under the docs site (see
allowlist below). Keep the package export or execute module focused on direct
docs retrieval instead of adding site-specific fallback machinery.

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

## Example module body

Adapt this into a package export or use it directly in `execute`.

```javascript
export default async () => {
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
		if (path !== path.trim()) {
			throw new Error('path must not have leading or trailing whitespace')
		}
		if (!path.startsWith('/') || path.startsWith('//')) {
			throw new Error('path must start with / and must not include a host')
		}
		if (path.length > 2048) throw new Error('path exceeds maximum length')
		if (/[\s#]/.test(path))
			throw new Error('path contains disallowed characters')
		if (path.includes('..') || /%2e/i.test(path)) {
			throw new Error('path must not contain ..')
		}
		if (!PREFIXES.some((prefix) => path.startsWith(prefix))) {
			throw new Error(`path must start with one of: ${PREFIXES.join(', ')}`)
		}
		const url = new URL(path, ORIGIN)
		if (url.origin !== ORIGIN) {
			throw new Error('path must stay on developers.cloudflare.com')
		}
		const pathname = url.pathname
		if (!PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
			throw new Error(`path must start with one of: ${PREFIXES.join(', ')}`)
		}
		return url
	}

	const path = '/api/resources/accounts/'
	const url = assertAllowedPath(path).toString()
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

For parameterized modules, accept a normal function argument (for example a
required `path` string) instead of a hard-coded path.

## Related

- Tracking: [issue #120](https://github.com/kentcdodds/kody/issues/120) (broader
  official patterns folder).
