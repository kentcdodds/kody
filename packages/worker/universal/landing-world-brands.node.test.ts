import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { docHref } from './docs-nav.ts'
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

test('invite chips link only to existing provider docs', () => {
	const linked = landingWorldBrands.filter(
		(brand): brand is typeof brand & { href: string } => 'href' in brand,
	)
	expect(linked.map((brand) => brand.label)).toEqual(['GitHub', 'Slack'])
	expect(linked.map((brand) => brand.href)).toEqual([
		docHref('github'),
		docHref('slack'),
	])
})
