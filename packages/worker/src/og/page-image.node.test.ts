import { expect, test } from 'vitest'
import { publicOgPages } from '#universal/og-pages.ts'
import { renderPageOgImage } from './page-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

test('renderPageOgImage returns valid PNG bytes for home and community', async () => {
	expect.hasAssertions()
	const home = await renderPageOgImage({ page: publicOgPages.home })
	expectPngBytes(home)

	const community = await renderPageOgImage({ page: publicOgPages.community })
	expectPngBytes(community)

	const blog = await renderPageOgImage({ page: publicOgPages.blog })
	expectPngBytes(blog)

	const discord = await renderPageOgImage({ page: publicOgPages.discord })
	expectPngBytes(discord)

	// Same copy as home, Discord path only — so a miss on hero/halo selection
	// cannot hide behind the different title and subtitle.
	const homeWithDiscordHero = await renderPageOgImage({
		page: { ...publicOgPages.home, path: '/discord' },
	})
	expectPngBytes(homeWithDiscordHero)
	expect(Buffer.from(home).equals(Buffer.from(homeWithDiscordHero))).toBe(false)
})

test('renderPageOgImage renders each theme differently', async () => {
	const light = await renderPageOgImage({
		page: publicOgPages.home,
		theme: 'light',
	})
	const dark = await renderPageOgImage({
		page: publicOgPages.home,
		theme: 'dark',
	})
	expectPngBytes(light)
	expectPngBytes(dark)

	// Valid PNG bytes alone would pass even if `theme` were ignored entirely,
	// which is the regression worth catching: the palette, the pattern tint, and
	// the halo all switch on it, so the two encodings cannot coincide.
	expect(Buffer.from(light).equals(Buffer.from(dark))).toBe(false)
})

test('homepage og query values render different cards and unknown stays default', async () => {
	const fallback = await renderPageOgImage({ page: publicOgPages.home })
	const unknown = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'nope',
	})
	const triggers = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'triggers',
	})
	const memory = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'memory',
	})
	const pricingWithQuery = await renderPageOgImage({
		page: publicOgPages.pricing,
		homeOg: 'triggers',
	})
	const pricing = await renderPageOgImage({ page: publicOgPages.pricing })

	expectPngBytes(triggers)
	expectPngBytes(memory)
	expect(Buffer.from(unknown).equals(Buffer.from(fallback))).toBe(true)
	expect(Buffer.from(triggers).equals(Buffer.from(fallback))).toBe(false)
	expect(Buffer.from(triggers).equals(Buffer.from(memory))).toBe(false)
	expect(Buffer.from(pricingWithQuery).equals(Buffer.from(pricing))).toBe(true)
})
