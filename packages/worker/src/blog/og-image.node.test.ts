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

test('blog OG renderer produces PNG for catalog posts with and without JPEG artwork', async () => {
	const textOnly = getBlogPost('your-assistants-home')
	expect(textOnly).toBeDefined()
	assertPng(
		await renderBlogPostOgImage({
			title: textOnly!.title,
			description: textOnly!.description,
			date: textOnly!.date,
		}),
	)

	const withArt = getBlogPost('kody-vs-executor')
	expect(withArt).toBeDefined()
	const artwork = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../public/images/kody-vs-executor-og.jpg',
		),
	)
	assertPng(
		await renderBlogPostOgImage({
			title: withArt!.title,
			description: withArt!.description,
			date: withArt!.date,
			imageDataUri: `data:image/jpeg;base64,${bytesToBase64(artwork)}`,
		}),
	)
})
