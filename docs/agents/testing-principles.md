# Testing principles

This codebase favors small, readable tests with explicit setup and minimal
magic.

## Principles

- Prefer flat test files: use top-level `test(...)` and avoid `describe`
  nesting.
- Avoid shared setup like `beforeEach`/`afterEach`; inline setup per test.
- Don't write tests for what the type system already guarantees.
- Use disposable objects only when there is real cleanup. If no cleanup, skip
  `using` and `Symbol.dispose`.
- Build helpers that return ready-to-run objects (factory pattern), not globals.
- Keep test intent obvious in the name: "auth handler returns 400 for invalid
  JSON".
- Write tests so they could run offline if necessary: avoid relying on the
  public internet and third-party services; prefer local fakes/fixtures.
- Prefer fast unit tests for server logic; keep e2e tests focused on journeys.
- Run server/unit tests with `npm run test` (plus targeted Vitest paths when
  needed) to avoid Playwright spec discovery and accidental matches like
  `packages/worker/src/mcp/mcp-server-e2e.test.ts`.

## Examples

### `Symbol.dispose` with `using`

```ts
import { writeFile, readFile, rm } from 'node:fs/promises'
import { test, expect } from 'vitest'

const createTempFile = async () => {
	const path = `/tmp/test-${crypto.randomUUID()}.txt`
	await writeFile(path, 'hello')

	return {
		path,
		[Symbol.asyncDispose]: async () => {
			await rm(path, { force: true }).catch(() => {
				// Cleanup should never fail the test.
			})
		},
	}
}

test('reads a temp file', async () => {
	await using tempFile = await createTempFile()
	const contents = await readFile(tempFile.path, 'utf8')
	expect(contents).toBe('hello')
})
```

### `Symbol.asyncDispose` with `await using`

```ts
import { createServer } from 'node:http'
import { test, expect } from 'vitest'

const createDisposableServer = async () => {
	const server = createServer((_request, response) => {
		response.end('ok')
	})
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to resolve test server port')
	}

	return {
		url: `http://localhost:${address.port}`,
		[Symbol.asyncDispose]: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

test('fetches from a disposable server', async () => {
	await using server = await createDisposableServer()
	const response = await fetch(server.url)
	expect(await response.text()).toBe('ok')
})
```
