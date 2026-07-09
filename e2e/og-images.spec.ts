import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

const ogListing = {
	listingId: 'e2e-og-listing',
	name: '@kody/og-image-package',
	description: 'OG image fixture package for public page meta tests.',
	tags: ['og', 'e2e'],
}

function expectPngBody(body: Buffer) {
	expect(body.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(body[index]).toBe(byte)
	}
}

test('public pages emit OG meta and serve generated PNG images', async ({
	request,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...ogListing,
		ownerEmail: primaryTestUser.email,
	})

	const homeHtml = await (await request.get('/')).text()
	expect(homeHtml).toContain('property="og:image"')
	expect(homeHtml).toContain('/og/home.png')
	expect(homeHtml).toContain(
		'name="twitter:card" content="summary_large_image"',
	)
	expect(homeHtml).toContain('rel="canonical"')

	const communityHtml = await (await request.get('/community')).text()
	expect(communityHtml).toContain('/og/community.png')

	const homePng = await request.get('/og/home.png')
	expect(homePng.status()).toBe(200)
	expect(homePng.headers()['content-type']).toContain('image/png')
	expect(homePng.headers()['cache-control']).toContain('max-age=3600')
	expectPngBody(Buffer.from(await homePng.body()))

	const missingPng = await request.get('/og/does-not-exist.png')
	expect(missingPng.status()).toBe(404)

	const detailHtml = await (
		await request.get(`/community/${ogListing.listingId}`)
	).text()
	expect(detailHtml).toContain(`/community/${ogListing.listingId}/og.png`)

	const listingPng = await request.get(
		`/community/${ogListing.listingId}/og.png`,
	)
	expect(listingPng.status()).toBe(200)
	expect(listingPng.headers()['content-type']).toContain('image/png')
	expectPngBody(Buffer.from(await listingPng.body()))
})
