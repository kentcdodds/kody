import { expect, test } from '@playwright/test'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import {
	executeE2eD1Command,
	seedCommunityListingInE2eDatabase,
	seedUserInE2eDatabase,
} from './d1-utils.ts'

const ogListing = {
	listingId: 'e2e-og-listing',
	name: '@kody/og-image-package',
	description: 'OG image fixture package for public page meta tests.',
	tags: ['og', 'e2e'],
}

const privateOgUser = {
	email: 'og-private@example.com',
	username: 'og_private',
	password: 'og-private-password',
}

test('public pages emit OG meta and serve generated PNG images', async ({
	request,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...ogListing,
		ownerEmail: primaryTestUser.email,
	})
	await seedUserInE2eDatabase(privateOgUser)
	executeE2eD1Command(
		`UPDATE users SET profile_visibility = 'private' WHERE username = ${quoteSqlString(privateOgUser.username)};`,
	)

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

	const blogHtml = await (await request.get('/blog')).text()
	expect(blogHtml).toContain('/og/blog.png')
	expect(blogHtml).toContain('application/rss+xml')
	expect(blogHtml).toContain('/blog/rss.xml')

	const homePng = await request.get('/og/home.png')
	expect(homePng.status()).toBe(200)
	expect(homePng.headers()['content-type']).toContain('image/png')
	expect(homePng.headers()['cache-control']).toContain('max-age=3600')

	const blogPng = await request.get('/og/blog.png')
	expect(blogPng.status()).toBe(200)
	expect(blogPng.headers()['content-type']).toContain('image/png')

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

	// Enumerate blog post OG images without hardcoding slugs: the index HTML
	// links each post, and each post page advertises its `/og.png`.
	const blogPostHrefs = [
		...blogHtml.matchAll(/href="(\/blog\/[a-z0-9-]+)"/g),
	].map((match) => match[1]!)
	expect(blogPostHrefs.length).toBeGreaterThan(0)
	for (const postHref of blogPostHrefs) {
		const postHtml = await (await request.get(postHref)).text()
		expect(postHtml).toContain(`${postHref}/og.png`)
		const postPng = await request.get(`${postHref}/og.png`)
		expect(postPng.status()).toBe(200)
		expect(postPng.headers()['content-type']).toContain('image/png')
	}

	const profileHtml = await (
		await request.get(`/@${primaryTestUser.username}`)
	).text()
	expect(profileHtml).toContain(`/profiles/${primaryTestUser.username}/og.png`)

	const profilePng = await request.get(
		`/profiles/${primaryTestUser.username}/og.png`,
	)
	expect(profilePng.status()).toBe(200)
	expect(profilePng.headers()['content-type']).toContain('image/png')
	expect(profilePng.headers()['cache-control']).toContain('max-age=3600')

	const privateProfilePng = await request.get(
		`/profiles/${privateOgUser.username}/og.png`,
	)
	expect(privateProfilePng.status()).toBe(404)
})
