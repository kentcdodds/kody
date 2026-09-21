import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { landingWorldBrands } from './landing-world-brands.ts'
import { walkthroughHostCatalog } from './walkthrough-hosts.ts'

const iconDirectory = join(
	dirname(fileURLToPath(import.meta.url)),
	'../public/images/icons',
)

const agentHostIcons = new Set(walkthroughHostCatalog.map((host) => host.icon))

test('homepage invite chips are services with existing public icon SVGs', () => {
	expect(landingWorldBrands.length).toBeGreaterThan(0)
	for (const brand of landingWorldBrands) {
		expect(agentHostIcons.has(brand.icon)).toBe(false)
		expect(existsSync(join(iconDirectory, `${brand.icon}.svg`))).toBe(true)
	}
})
