import { expect, test } from 'vitest'
import { publicOgPages } from './pages.ts'
import { renderPageOgImage } from './page-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

test('renderPageOgImage returns valid PNG bytes for home and community', async () => {
	const home = await renderPageOgImage({
		page: publicOgPages.home,
		label: 'heykody.dev',
	})
	expectPngBytes(home)

	const community = await renderPageOgImage({
		page: publicOgPages.community,
		label: 'heykody.dev',
	})
	expectPngBytes(community)

	const blog = await renderPageOgImage({
		page: publicOgPages.blog,
		label: 'heykody.dev',
	})
	expectPngBytes(blog)
})
