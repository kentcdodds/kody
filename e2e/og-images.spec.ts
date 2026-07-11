import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

const ogListing = {
	listingId: 'e2e-og-listing',
	name: '@kody/og-image-package',
	description: 'OG image fixture package for public page meta tests.',
	tags: ['og', 'e2e'],
}

test('public pages emit OG meta and serve generated PNG images', async ({
	request,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...ogListing,
		ownerEmail: primaryTestUser.email,
	})

	// Seeding above shells out to `wrangler d1 execute` for multiple seconds.
	// Playwright's APIRequestContext pools keep-alive sockets in a
	// process-global agent, so the first request after that idle gap can race
	// the dev server closing the stale socket ("socket hang up"/ECONNRESET).
	// `maxRetries` opts into Playwright's built-in ECONNRESET-only retry.
	const homeHtml = await (await request.get('/', { maxRetries: 1 })).text()
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
})
