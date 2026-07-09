import { expect, test } from 'vitest'
import { publicOgPages } from './pages.ts'
import { renderPageOgImage } from './page-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('renderPageOgImage works in workerd', async () => {
	const png = await renderPageOgImage({
		page: publicOgPages.home,
		label: 'heykody.dev',
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
