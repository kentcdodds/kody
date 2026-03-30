# Testing principles

This codebase favors small, readable test suites with explicit setup and
minimal magic. Individual tests should follow a meaningful workflow end-to-end,
even when that makes a single test longer and more assertion-heavy.

## Principles

- Prefer the "fewer, longer tests" style from Kent C. Dodds when assertions
  belong to one workflow.
- Treat each test like a manual tester's script: one setup, then as many
  actions and assertions as needed to validate the whole journey.
- Do not split a single flow into many tiny tests just to satisfy "one
  assertion per test." Multiple related assertions in one test are a feature,
  not a smell.
- Prefer flat test files: use top-level `test(...)` and avoid `describe`
  nesting.
- Avoid shared setup like `beforeEach`/`afterEach`; inline setup per test.
- Avoid shared mutable test state across cases. If the next assertion depends on
  the same rendered object, request, or response, it likely belongs in the same
  test.
- Don't write tests for what the type system already guarantees.
- Use disposable objects only when there is real cleanup. If no cleanup, skip
  `using` and `Symbol.dispose`.
- Build helpers that return ready-to-run objects (factory pattern), not globals.
- Keep test intent obvious in the name: "auth handler returns 400 for invalid
  JSON".
- Write tests so they could run offline if necessary: avoid relying on the
  public internet and third-party services; prefer local fakes/fixtures.
- Keep the bar for adding tests high, especially slower integration and E2E
  tests.
- Prefer fast unit tests for server logic; keep e2e tests focused on a very
  small number of important happy-path journeys.
- Prefer asserting intermediate states inside the broader workflow that causes
  them rather than adding isolated tests that only check an incidental loading
  or transition state.
- Do not add regression tests for bugs that are unlikely to happen again unless
  the flow is important enough to justify the maintenance cost.
- Avoid tests that only assert a string blob contains a description or other
  incidental copy. Favor behavior-focused assertions (structured output,
  user-visible outcomes, or stable public contracts) instead.
- Run server/unit tests with `npm run test` (plus targeted Vitest paths when
  needed) to avoid Playwright spec discovery and accidental matches like
  `packages/worker/src/mcp/mcp-server.mcp-e2e.test.ts`.

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
