// Regression coverage for a CI flake: when the community frame prefetch
// degrades and the fallback frame fetch is slow, the document is still too
// short when pop-navigation scroll restoration first runs. Restoration must
// retry until the grown content makes the saved position reachable.
import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

const listing = {
	listingId: 'e2e-slow-frame-listing',
	name: '@kody/slow-frame-package',
	description: 'Slow frame fixture package for scroll restoration tests.',
	tags: ['slow', 'frame'],
}

const longReadme = `# Scroll restoration fixture

${Array.from({ length: 24 }, (_, index) => {
	return `This README paragraph ${index + 1} makes the detail route scrollable.`
}).join('\n\n')}`

test('scroll restoration retries until slow frame content makes the saved position reachable', async ({
	page,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...listing,
		ownerEmail: primaryTestUser.email,
		readmeContent: longReadme,
	})

	await page.goto('/community')
	await expect(page.getByText(listing.description)).toBeVisible()
	await page.setViewportSize({ width: 900, height: 320 })

	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
	// Clicking auto-scrolls the link into view, which the router saves as the
	// pop-restoration position. Make that scroll explicit and measure the
	// position the click actually navigates from.
	await page.getByRole('link', { name: listing.name }).scrollIntoViewIfNeeded()
	const communityScrollY = await page.evaluate(() => window.scrollY)
	expect(communityScrollY).toBeGreaterThan(0)

	await page.getByRole('link', { name: listing.name }).click()
	await expect(page).toHaveURL(new RegExp(`/community/${listing.listingId}$`))
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

	await page.evaluate(() => window.scrollTo(0, 40))
	const detailScrollY = await page.evaluate(() => window.scrollY)
	expect(detailScrollY).toBeGreaterThan(0)

	// Abort the loader's frame prefetch so it degrades to the post-commit
	// frame fetch, then serve that fallback slowly. The pop navigation commits
	// with a short document and content grows ~1.5s later.
	let frameRequestCount = 0
	await page.route(
		(url) => url.pathname === '/community',
		async (route) => {
			if (route.request().headers()['x-remix-target'] === undefined) {
				await route.continue()
				return
			}
			frameRequestCount += 1
			if (frameRequestCount === 1) {
				await route.abort()
				return
			}
			await new Promise((resolve) => setTimeout(resolve, 1500))
			await route.continue()
		},
	)

	await page.goBack()
	await expect(page).toHaveURL(/\/community$/)
	await expect(page.getByText(listing.description)).toBeVisible({
		timeout: 10_000,
	})
	// Restoration must land back at the saved bottom-of-list position, not
	// merely somewhere below the detail page's small offset.
	await expect
		.poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
		.toBeGreaterThanOrEqual(communityScrollY - 2)
})
