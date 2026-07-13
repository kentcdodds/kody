import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import { renderCommunityOgImage } from './og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

async function sampleIconDataUri(name: string) {
	const png = await renderCommunityIconFallbackPng(name)
	return `data:image/png;base64,${bytesToBase64(png)}`
}

test('renderCommunityOgImage returns valid PNG bytes with and without ratings', async () => {
	const withRatings = await renderCommunityOgImage({
		name: '@kody/github-triage',
		description:
			'automatically triage new GitHub issues with labels, assignees, and a friendly first response for your open-source repos',
		ownerUsername: 'kody',
		averageStars: 4.6,
		ratingCount: 12,
		forkCount: 37,
		iconDataUri: await sampleIconDataUri('@kody/github-triage'),
	})
	expectPngBytes(withRatings)

	const withoutRatings = await renderCommunityOgImage({
		name: '@kody/new-package',
		description: 'summarize your inbox every morning',
		ownerUsername: 'jane',
		averageStars: null,
		ratingCount: 0,
		forkCount: 2,
		iconDataUri: await sampleIconDataUri('@kody/new-package'),
	})
	expectPngBytes(withoutRatings)
})

test('renderCommunityOgImage clamps a long description without overflowing', async () => {
	const png = await renderCommunityOgImage({
		name: '@kody/long-description-package',
		description:
			'this is an intentionally very long community package description that would previously overrun the OG card after the hard-coded Use Kody to prefix was prepended, including extra clauses about labels, assignees, digests, reminders, and weekly digests for multiple teams',
		ownerUsername: 'kody',
		averageStars: 3.5,
		ratingCount: 4,
		forkCount: 1,
		iconDataUri: await sampleIconDataUri('@kody/long-description-package'),
	})
	expectPngBytes(png)
})
