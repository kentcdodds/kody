import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseJsonc } from '../../tools/ci/resource-utils.ts'

const config = parseJsonc<{
	vars: { PRIMARY_WORKER_ORIGIN?: string }
}>(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'))

test('PRIMARY_WORKER_ORIGIN is the canonical production origin', () => {
	expect(config.vars.PRIMARY_WORKER_ORIGIN).toBe('https://kody.codes')
	expect(JSON.stringify(config.vars)).not.toMatch(
		/heykody\.(?:app|dev)|kodyapps\.dev/,
	)
})
