# Testing principles

This codebase favors small, readable test suites with explicit setup and minimal
magic. Individual tests should follow a meaningful workflow end-to-end, even
when that makes a single test longer and more assertion-heavy.

## Test flavor decision matrix

Choose the lightest flavor that can falsify the behavior. Filename suffixes pick
the Vitest project (`vitest.config.ts`):

| Flavor / command                                                                    | Use when                                                                                                                                                                                                                                                                                                        | Avoid when                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.node.test.ts` (`npm run test:node` / node-unit; also in `npm run test`)          | Pure server logic, pure functions, handlers/services that can run against an in-memory `node:sqlite` D1 facade (`createD1FromSqlite` in `packages/worker/src/test-support/`), or code that is correctly covered by spies/stubs (for example `vi.spyOn` on `recordUsage`). Fast feedback; no Workers runtime.    | The assertion needs real Cloudflare bindings (`env.APP_DB`, KV, DO, R2) or Workers-only APIs that the node stubs do not honestly exercise.                                                                                                         |
| `*.workers.test.ts` (`npm run test:workers` / workers-unit; also in `npm run test`) | The behavior depends on real local bindings from `cloudflare:workers` / the Vitest Workers pool (D1 schema + queries, KV reads/writes, DO stubs as configured). Prefer shared explicit-import factories from `packages/worker/src/test-support/` and domain `test-schema.ts` helpers over copy-pasted seed SQL. | The file never reads `env` / bindings and only tests pure registry or string logic — prefer `*.node.test.ts` instead (several `src/mcp/**` workers suites are historical misclassifications; leave them unless you are already editing that area). |
| `*.mcp-e2e.test.ts` (`npm run test:mcp`)                                            | A tiny smoke suite for the real MCP HTTP transport, OAuth, and package-app session wiring.                                                                                                                                                                                                                      | Capability-by-capability coverage that does not need that transport — put those beside the implementation as node or workers tests.                                                                                                                |
| Playwright (`npm run test:e2e:run`)                                                 | A very small number of user-critical happy-path journeys through the worker + client. See [end-to-end testing](./end-to-end-testing.md).                                                                                                                                                                        | Edge cases, copy pinning, or anything a faster unit/integration test can cover.                                                                                                                                                                    |

**Usage metering example** (lifted from
[usage metering](./architecture/usage-metering.md)): in `*.node.test.ts`, spy on
`recordUsage` and assert call shape for success and failure paths. In
`*.workers.test.ts` with a real local D1, call `ensureUsageRollupsTestSchema`
from `packages/worker/src/usage/test-schema.ts` and assert on `usage_rollups`
rows instead of spying.

Shared test helpers live under `packages/worker/src/test-support/`. Import
factories explicitly inside each test (or a per-test factory). Do not introduce
`beforeEach` hooks that hide setup — that conflicts with the principles below.

## Principles

- Prefer the "fewer, longer tests" style from Kent C. Dodds when assertions
  belong to one workflow.
- Treat each test like a manual tester's script: one setup, then as many actions
  and assertions as needed to validate the whole journey.
- Do not split a single flow into many tiny tests just to satisfy "one assertion
  per test." Multiple related assertions in one test are a feature, not a smell.
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
- Treat `packages/worker/src/mcp/*.mcp-e2e.test.ts` as a tiny MCP transport
  smoke suite. Do not add capability-specific cases there unless they require
  the real MCP HTTP transport, OAuth flow, and package-app session wiring.
- Prefer asserting intermediate states inside the broader workflow that causes
  them rather than adding isolated tests that only check an incidental loading
  or transition state.
- Do not add regression tests for bugs that are unlikely to happen again unless
  the flow is important enough to justify the maintenance cost.
- Avoid tests that only assert a string blob contains a description or other
  incidental copy. Favor behavior-focused assertions (structured output,
  user-visible outcomes, or stable public contracts) instead.
- Do not add tests whose only value is pinning configuration-style strings such
  as tool descriptions, usage hints, warnings, or other instructional copy. If
  the behavior matters, test the behavior or stable structured contract rather
  than asserting that specific prose appears.
- Run server/unit tests with `npm run test` (plus targeted Vitest paths when
  needed) to avoid Playwright spec discovery and accidental matches like
  `packages/worker/src/mcp/mcp-server.mcp-e2e.test.ts`.
- Vitest is configured with `clearMocks` and `mockReset` globally
  (`vitest-shared.ts`). Each test starts with a clean mock slate; inline the
  setup a test needs rather than relying on leftover state from a prior case.
  Keep explicit mid-test resets only when one workflow test runs multiple
  scenarios in a single `test(...)`.
- Console output is guarded globally
  (`packages/worker/src/test-support/console-spies.ts`, wired via `setupFiles`):
  unexpected `console.error`/`console.warn` calls fail the test, and
  `console.info`/`console.debug` are silenced. Never silence blindly — a blanket
  `.mockImplementation(() => {})` can hide a real regression. Instead:
  - When the log is part of the tested contract, import the exported
    `consoleError`/`consoleWarn` spies, call `.mockImplementation(() => {})`,
    and assert on the calls (prefer the stable first-argument tag plus
    `expect.any(Error)`; do not pin long prose). Assert the call count too when
    it is deterministic.
  - When the log is incidental to the behavior under test, use
    `silenceExpectedConsoleWarns([...])` / `silenceExpectedConsoleErrors([...])`
    (same module) with the exact expected message tags, or
    `silenceIncidentalRuntimeWarnings()`
    (`packages/worker/src/test-support/incidental-runtime-warnings.ts`) for the
    bundler/registry-runtime noise set. Anything outside the allowlist still
    fails the test.

  Keep test output free of stray logging.

- The audit-log sink is mocked globally for `node-unit` tests
  (`packages/worker/src/test-support/audit-log-spy.ts`, wired via the project's
  `setupFiles`): import `logAuditEventSpy` and assert the audit events a handler
  is expected to emit (and `not.toHaveBeenCalled()` where none are). Tests that
  exercise the real audit pipeline opt out with
  `vi.unmock('#worker/audit-log.ts')`; tests that need to override other exports
  (e.g. `getRequestIp`) declare their own `vi.mock('#worker/audit-log.ts', ...)`
  and route `logAuditEvent` back through the shared spy.

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
