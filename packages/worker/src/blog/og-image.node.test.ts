import { expect, test } from 'vitest'
import { getBlogPost } from './catalog.ts'
import { renderBlogPostOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('blog OG renderer draws the post title and description', async () => {
	const post = getBlogPost('kody-vs-executor')
	expect(post).toBeDefined()

	const png = await renderBlogPostOgImage({
		title: post!.title,
		description: post!.description,
		date: post!.date,
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
