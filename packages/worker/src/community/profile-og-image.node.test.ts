import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test, vi } from 'vitest'
import { resetTwemojiCache, twemojiSvgUrl } from '#worker/og/og-emoji.ts'
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

test('renderProfileOgImage returns valid PNG bytes with avatar, placeholder, and Twemoji', async () => {
	expect.hasAssertions()
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

	// Satori's Latin fonts turn 🐨 into a .notdef box unless Twemoji is
	// loaded. The fetch is the production path; stub the SVG so the suite
	// stays offline.
	resetTwemojiCache()
	const koalaSvg = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../og/fixtures/twemoji-1f428.svg',
		),
		'utf8',
	)
	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) => {
			const url = String(input)
			if (url === twemojiSvgUrl('1f428')) {
				return new Response(koalaSvg, { status: 200 })
			}
			throw new Error(`unexpected fetch: ${url}`)
		})
	try {
		const avatarDataUri = await sampleAvatarDataUri('kentcdodds')
		const sharedCard = {
			username: 'kentcdodds',
			bio: 'Husband, 6x Dad, Latter-day Saint, Dev, Educator.',
			followerCount: 28,
			publicPackageCount: 31,
			listingCount: 26,
			avatarDataUri,
		} as const
		const withEmoji = await renderProfileOgImage({
			...sharedCard,
			displayName: 'Kent C. Dodds 🐨',
		})
		const withoutEmoji = await renderProfileOgImage({
			...sharedCard,
			displayName: 'Kent C. Dodds',
		})
		expectPngBytes(withEmoji)
		expectPngBytes(withoutEmoji)
		expect(fetchSpy).toHaveBeenCalledWith(
			twemojiSvgUrl('1f428'),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(Buffer.from(withEmoji).equals(Buffer.from(withoutEmoji))).toBe(false)
	} finally {
		fetchSpy.mockRestore()
		resetTwemojiCache()
	}
})
