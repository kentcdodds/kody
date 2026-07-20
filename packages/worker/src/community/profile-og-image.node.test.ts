import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test } from 'vitest'
import { renderCommunityIconFallbackPng } from './community-icon.ts'
import { renderProfileOgImage } from './profile-og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

async function sampleAvatarDataUri(name: string) {
	const png = await renderCommunityIconFallbackPng(name)
	return `data:image/png;base64,${bytesToBase64(png)}`
}

test('renderProfileOgImage returns valid PNG bytes with and without avatar', async () => {
	const withAvatar = await renderProfileOgImage({
		displayName: 'Jane Doe',
		username: 'jane',
		bio: 'Builds weather bots and keeps community packages tidy for everyone.',
		followerCount: 12,
		publicPackageCount: 3,
		listingCount: 1,
		avatarDataUri: await sampleAvatarDataUri('jane'),
	})
	expectPngBytes(withAvatar)

	const withoutAvatar = await renderProfileOgImage({
		displayName: 'Kody',
		username: 'kody',
		bio: null,
		followerCount: 1,
		publicPackageCount: 1,
		listingCount: 0,
		avatarDataUri: null,
	})
	expectPngBytes(withoutAvatar)
})
