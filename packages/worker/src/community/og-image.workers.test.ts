import { expect, test } from 'vitest'
import { renderCommunityOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('renderCommunityOgImage works in workerd', async () => {
	const png = await renderCommunityOgImage({
		name: '@kody/github-triage',
		description: 'triage GitHub issues with labels and assignees',
		ownerUsername: 'kody',
		averageStars: 4.2,
		ratingCount: 5,
		forkCount: 9,
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
