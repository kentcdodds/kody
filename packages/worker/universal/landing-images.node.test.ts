import { expect, test } from 'vitest'
import { heroBaseImage, landingArtAttrs } from '#universal/landing-images.ts'

test('landing art prefers smaller defaults and only advertises 960w when wide enough', () => {
	expect(heroBaseImage.src).toBe('/images/hero/kody-base-640.webp')
	expect(heroBaseImage.srcSet).toContain('640w')
	expect(heroBaseImage.srcSet).toContain('960w')
	expect(heroBaseImage.srcSet).toContain('1254w')

	const greeting = landingArtAttrs('kody-greeting')
	expect(greeting.src).toContain('-480.webp')
	expect(greeting.srcSet).toContain('480w')
	expect(greeting.srcSet).not.toContain('960w')
	expect(greeting.loading).toBe('lazy')

	expect(landingArtAttrs('kody-compounding-capabilities').srcSet).toContain(
		'960w',
	)
	const factoryMap = landingArtAttrs('kody-factory-map')
	expect(factoryMap.src).toBe('/images/kody-factory-map-480.webp')
	expect(factoryMap.srcSet).toContain('/images/kody-factory-map-960.webp 960w')
	expect(factoryMap.srcSet).toContain('/images/kody-factory-map.webp 1024w')
	expect(landingArtAttrs('kody-community-packages').srcSet).not.toContain(
		'960w',
	)
	expect(landingArtAttrs('kody-keys').srcSet).not.toContain('960w')
})
