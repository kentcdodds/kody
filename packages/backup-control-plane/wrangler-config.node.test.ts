import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const wranglerSource = readFileSync(
	new URL('./wrangler.jsonc', import.meta.url),
	'utf8',
)

test('PRIMARY_WORKER_ORIGIN is the canonical production origin', () => {
	expect(wranglerSource).toMatch(
		/"PRIMARY_WORKER_ORIGIN": "https:\/\/kody\.codes"/,
	)
	expect(wranglerSource).not.toMatch(/heykody\.(?:app|dev)|kodyapps\.dev/)
})
