import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)

/**
 * Guards the Zod locales barrel patch (`patches/zod+4.6.5.patch`). Without it,
 * `import { z } from 'zod'` pulls ~50 locale modules into every Worker main
 * module (~190 KB on runtime/platform). See
 * docs/contributing/architecture/startup-budget.md.
 */
describe('zod locales barrel patch', () => {
	test('exposes only the English locale from the locales index', async () => {
		const locales = await import('zod/v4/locales/index.js')
		expect(Object.keys(locales).sort()).toEqual(['en'])
		expect(typeof locales.en).toBe('function')

		const cjsLocales = require('zod/v4/locales') as { en?: unknown }
		expect(Object.keys(cjsLocales).sort()).toEqual(['en'])
		expect(typeof cjsLocales.en).toBe('function')
	})

	test('classic zod entry still validates with English messages', async () => {
		const { z } = await import('zod')
		const result = z.string().safeParse(1)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.issues[0]?.message).toMatch(/string/i)
	})
})
