import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { landingWorldBrands } from './landing-world-brands.ts'

const iconDirectory = join(
	dirname(fileURLToPath(import.meta.url)),
	'../public/images/icons',
)

test('homepage world-brand chips use existing public icon SVGs', () => {
	for (const brand of landingWorldBrands) {
		expect(existsSync(join(iconDirectory, `${brand.icon}.svg`))).toBe(true)
	}
})
