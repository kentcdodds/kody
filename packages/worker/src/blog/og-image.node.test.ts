import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { getBlogPost } from './catalog.ts'
import { renderBlogPostOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function assertPng(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

test('blog OG renderer draws the post title and description', async () => {
	const post = getBlogPost('your-assistants-home')
	expect(post).toBeDefined()

	const png = await renderBlogPostOgImage({
		title: post!.title,
		description: post!.description,
		date: post!.date,
	})
	assertPng(png)
})

test('blog OG renderer composes title, description, and JPEG artwork', async () => {
	const post = getBlogPost('kody-vs-executor')
	expect(post).toBeDefined()
	const artwork = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../public/images/kody-vs-executor-og.jpg',
		),
	)

	const png = await renderBlogPostOgImage({
		title: post!.title,
		description: post!.description,
		date: post!.date,
		imageDataUri: `data:image/jpeg;base64,${bytesToBase64(artwork)}`,
	})
	assertPng(png)
})
