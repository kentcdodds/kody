import { expect, test } from 'vitest'
import { heroBaseImage, landingArtAttrs } from '#universal/landing-images.ts'

test('hero LCP preload points at the mobile-sized variant and lists larger sources', () => {
	expect(heroBaseImage.src).toBe('/images/hero/kody-base-640.webp')
	expect(heroBaseImage.srcSet).toContain('kody-base-640.webp 640w')
	expect(heroBaseImage.srcSet).toContain('kody-base-960.webp 960w')
	expect(heroBaseImage.srcSet).toContain('kody-base.webp 1254w')
})

test('landing art attrs prefer the 480w file and keep the original as the largest candidate', () => {
	const attrs = landingArtAttrs('kody-greeting')
	expect(attrs.src).toBe('/images/kody-greeting-480.webp')
	expect(attrs.srcSet).toContain('kody-greeting-480.webp 480w')
	expect(attrs.srcSet).toContain('kody-greeting-960.webp 960w')
	expect(attrs.srcSet).toContain('kody-greeting.webp 700w')
	expect(attrs.loading).toBe('lazy')
})
