import { expect, test } from 'vitest'
import { renderProfileOgImage } from './profile-og-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

test('renderProfileOgImage works in workerd', async () => {
	const png = await renderProfileOgImage({
		displayName: 'Jane Doe',
		username: 'jane',
		bio: 'Community profile OG image fixture.',
		followerCount: 4,
		publicPackageCount: 2,
		listingCount: 1,
		avatarDataUri: null,
	})

	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
})
