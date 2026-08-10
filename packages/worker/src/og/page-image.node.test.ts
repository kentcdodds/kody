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
	const home = await renderPageOgImage({ page: publicOgPages.home })
	expectPngBytes(home)

	const community = await renderPageOgImage({ page: publicOgPages.community })
	expectPngBytes(community)

	const blog = await renderPageOgImage({ page: publicOgPages.blog })
	expectPngBytes(blog)
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
