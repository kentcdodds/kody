import { expect, test } from 'vitest'
import { createExecutorModuleSource } from './executor.ts'

test('executor fetch wrapper reads secret authority before awaiting recordFetch', () => {
	const allowed = createExecutorModuleSource({
		code: 'async () => "ok"',
		providers: [
			{
				name: 'kody',
				fns: {},
			},
		],
		shadowGlobalThis: false,
		timeoutMs: 1_000,
	})
	// Stamp must be read before awaiting host recordFetch RPC — ALS may not
	// survive that await, and ad-hoc execute has no run packageId fallback.
	const authorityIdx = allowed.indexOf(
		'globalThis[Symbol.for("kody.getSecretAuthority")]',
	)
	const recordFetchIdx = allowed.indexOf('.call("recordFetch", "[]")')
	expect(authorityIdx).toBeGreaterThan(-1)
	expect(recordFetchIdx).toBeGreaterThan(-1)
	expect(authorityIdx).toBeLessThan(recordFetchIdx)
})
