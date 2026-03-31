# Testing and related work

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Testing

Testing is straightforward because `fetch-router` uses the standard `fetch()`
API:

```ts
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('blog routes', () => {
	it('creates a new post', async () => {
		let response = await router.fetch('https://api.remix.run/posts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Hello', content: 'World' }),
		})

		assert.equal(response.status, 201)
		let post = await response.json()
		assert.equal(post.title, 'Hello')
	})

	it('returns 404 for missing posts', async () => {
		let response = await router.fetch('https://api.remix.run/posts/not-found')
		assert.equal(response.status, 404)
	})
})
```

No special test harness or mocking required! Just use `fetch()` like you would
in production.

## Related work

- [@remix-run/response](../response/index.md) - Response helpers for HTML, JSON,
  files, and redirects
- [@remix-run/headers](../headers/index.md) - A library for working with HTTP
  headers
- [@remix-run/form-data-parser](../form-data-parser) - A library for parsing
  multipart/form-data requests
- [@remix-run/route-pattern](../route-pattern) - The pattern matching library
  that powers `fetch-router`
- [Express](https://expressjs.com/) - The classic Node.js web framework

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [fetch-router overview](./index.md)
- [Remix package index](../index.md)
