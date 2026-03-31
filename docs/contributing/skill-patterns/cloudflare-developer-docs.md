# Skill pattern: Cloudflare Developer Docs (`developers.cloudflare.com`)

The **`cloudflare_api_docs`** builtin capability was removed in favor of **saved
skills** (or one-off **`execute`** code) so Cloudflare-specific doc reading can
evolve without shipping Worker changes.

Use this pattern when you need API or product documentation from
[developers.cloudflare.com](https://developers.cloudflare.com).

## Prefer cheaper steps first

1. **Markdown-preferred `fetch`** against a path under the docs site (see
   allowlist below). Matches what the old builtin did before any billed
   fallback.
2. If the response is still hard to use (heavy HTML, etc.), call
   **`codemode.page_to_markdown`** with the same URL so Browser Rendering runs
   only when needed (billed).

## Path allowlist (same policy as the former builtin)

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

## Example skill body (save via `meta_save_skill`)

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
	const contentType = res.headers.get('content-type')
	const needsFallback =
		contentType?.includes('text/html') && body.trimStart().startsWith('<')
	if (needsFallback) {
		return await codemode.page_to_markdown({ url })
	}
	return {
		status: res.status,
		contentType,
		markdownTokenEstimate: res.headers.get('x-markdown-tokens'),
		body: body.slice(0, 500_000),
	}
}
```

For parameterized skills, use **`meta_save_skill`** **`parameters`** (e.g. a
required `path` string) and read **`params.path`** instead of a hard-coded path.

## Related

- Billed fallback: **`page_to_markdown`** (`packages/worker` coding domain).
- Tracking: [issue #120](https://github.com/kentcdodds/kody/issues/120) (broader
  official patterns folder).
