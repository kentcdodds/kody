import { writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { renderCommunityOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

test('renderCommunityOgImage returns a PNG with ratings', async () => {
	const png = await renderCommunityOgImage({
		name: '@kody/github-triage',
		description:
			'automatically triage new GitHub issues with labels, assignees, and a friendly first response for your open-source repos',
		ownerUsername: 'kody',
		averageStars: 4.6,
		ratingCount: 12,
		forkCount: 37,
	})

	expectPngBytes(png)
	writeFileSync('/tmp/og-image-sample.png', png)
})

test('renderCommunityOgImage returns a PNG without ratings', async () => {
	const png = await renderCommunityOgImage({
		name: '@kody/new-package',
		description: 'summarize your inbox every morning',
		ownerUsername: 'jane',
		averageStars: null,
		ratingCount: 0,
		forkCount: 2,
	})

	expectPngBytes(png)
	writeFileSync('/tmp/og-image-norating.png', png)
})
