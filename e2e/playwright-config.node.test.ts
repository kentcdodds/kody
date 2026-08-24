import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('e2e wrangler keeps incoming request-body draining enabled', () => {
	const source = readFileSync(
		new URL('../playwright.config.ts', import.meta.url),
		'utf8',
	)

	expect(source).not.toMatch(/WRANGLER_DISABLE_REQUEST_BODY_DRAINING\s*:/)
})
