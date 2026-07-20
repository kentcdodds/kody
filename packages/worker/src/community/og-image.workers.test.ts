import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import { renderCommunityOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('renderCommunityOgImage works in workerd', async () => {
	const iconPng = await renderCommunityIconFallbackPng('@kody/github-triage')
	const png = await renderCommunityOgImage({
		name: '@kody/github-triage',
		description: 'triage GitHub issues with labels and assignees',
		ownerUsername: 'kody',
		averageStars: 4.2,
		ratingCount: 5,
		forkCount: 9,
		starCount: 3,
		iconDataUri: `data:image/png;base64,${bytesToBase64(iconPng)}`,
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
