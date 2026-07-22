import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

const alphaListing = {
	listingId: 'e2e-ssr-listing-alpha',
	name: '@kody/alpha-ssr-package',
	description: 'Alpha SSR fixture package for hydration tests.',
	tags: ['alpha', 'ssr'],
}

const betaListing = {
	listingId: 'e2e-ssr-listing-beta',
	name: '@kody/beta-ssr-package',
	description: 'Beta SSR fixture package for hydration tests.',
	tags: ['beta', 'ssr'],
}

const longReadme = `# Scroll restoration fixture

## Intent

${Array.from({ length: 24 }, (_, index) => {
	return `This README paragraph ${index + 1} makes the detail route scrollable.`
}).join('\n\n')}`

test('SSR community HTML hydrates SPA navigation and client search', async ({
	page,
	request,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...alphaListing,
		ownerEmail: primaryTestUser.email,
		readmeContent: longReadme,
	})
	await seedCommunityListingInE2eDatabase({
		...betaListing,
		ownerEmail: primaryTestUser.email,
		readmeContent: longReadme,
	})

	// First API request after the multi-second `wrangler d1 execute` seeding
	// gap can reuse a keep-alive socket the dev server already closed
	// ("socket hang up"). `maxRetries` enables Playwright's ECONNRESET retry.
	const htmlResponse = await request.get('/community', { maxRetries: 1 })
	expect(htmlResponse.ok()).toBe(true)
	const rawHtml = await htmlResponse.text()
	expect(rawHtml).toContain(alphaListing.description)
	expect(rawHtml).toContain(betaListing.name)
	expect(rawHtml).not.toContain('Loading community packages')
	expect(rawHtml).toContain('data-testid="community-listings-frame"')
	expect(rawHtml).not.toContain('"community"')

	const filteredHtmlResponse = await request.get('/community?q=beta')
	expect(filteredHtmlResponse.ok()).toBe(true)
	const filteredHtml = await filteredHtmlResponse.text()
	expect(filteredHtml).toContain(betaListing.description)
	expect(filteredHtml).not.toContain(alphaListing.name)

	await page.goto('/community')
	await expect(page.getByText(alphaListing.description)).toBeVisible()
	await expect(page.getByText(betaListing.description)).toBeVisible()
	await page.setViewportSize({ width: 900, height: 320 })

	await page.evaluate(() => {
		;(window as Window & { __e2eMarker?: boolean }).__e2eMarker = true
	})

	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
	// Clicking auto-scrolls the link into view, which the router saves as the
	// pop-restoration position. Make that scroll explicit and measure the
	// position the click actually navigates from.
	await page
		.getByRole('link', { name: alphaListing.name })
		.scrollIntoViewIfNeeded()
	const communityScrollY = await page.evaluate(() => window.scrollY)
	expect(communityScrollY).toBeGreaterThan(0)

	await page.getByRole('link', { name: alphaListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${alphaListing.listingId}$`),
	)
	await expect(page.getByText(alphaListing.description)).toBeVisible()
	// The README renders as markdown (its `#` title becomes a heading
	// element via the safe renderer), not as a raw markdown string.
	await expect(
		page.getByRole('heading', { name: 'Scroll restoration fixture' }),
	).toBeVisible()
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	await page.evaluate(async (targetScrollY) => {
		if (window.scrollY === targetScrollY) return

		await new Promise<void>((resolve) => {
			let fallbackFrame = requestAnimationFrame(() => {
				fallbackFrame = requestAnimationFrame(finish)
			})

			function finish() {
				window.removeEventListener('scroll', finish)
				cancelAnimationFrame(fallbackFrame)
				resolve()
			}

			window.addEventListener('scroll', finish, { once: true })
			window.scrollTo(0, targetScrollY)
		})
	}, 40)
	const detailScrollY = await page.evaluate(() => window.scrollY)
	expect(detailScrollY).toBeGreaterThan(0)
	expect(detailScrollY).not.toBe(communityScrollY)
	expect(communityScrollY).toBeGreaterThan(detailScrollY + 20)
	await page.goBack()
	await expect(page).toHaveURL(/\/community$/)
	// Scroll restoration retries until the async listings frame renders and
	// the saved position becomes reachable, so wait for the content first.
	// Generous timeouts: in CI the whole validate pipeline shares one runner
	// and the frame fetch alone can take several seconds.
	await expect(page.getByText(alphaListing.description)).toBeVisible({
		timeout: 15_000,
	})
	// Restoration must land back at the saved bottom-of-list position, not
	// merely somewhere below the detail page's small offset.
	await expect
		.poll(() => page.evaluate(() => window.scrollY), { timeout: 15_000 })
		.toBeGreaterThanOrEqual(communityScrollY - 2)

	await page
		.getByRole('link', { name: betaListing.name })
		.evaluate((link) => link.setAttribute('data-prevent-scroll-reset', ''))
	await page.evaluate(() => window.scrollTo(0, 80))
	const preservedScrollY = await page.evaluate(() => window.scrollY)
	expect(preservedScrollY).toBeGreaterThan(0)
	await page.getByRole('link', { name: betaListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${betaListing.listingId}$`),
	)
	await expect(page.getByText(betaListing.description)).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(0)

	await page.getByRole('link', { name: 'Community', exact: true }).click()
	await expect(page).toHaveURL(/\/community$/)
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	await page.getByRole('link', { name: betaListing.name }).evaluate((link) => {
		link.setAttribute('href', `${link.getAttribute('href')}#report`)
	})
	await page.getByRole('link', { name: betaListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${betaListing.listingId}#report$`),
	)
	await expect(
		page.getByRole('heading', { name: 'Report this listing' }),
	).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(0)

	await page.getByRole('link', { name: 'Community', exact: true }).click()
	await expect(page).toHaveURL(/\/community$/)

	await page
		.getByPlaceholder('Search by name, description, or tags')
		.fill('beta')
	await page.getByRole('button', { name: 'Search' }).click()
	await expect(page).toHaveURL(/\/community\?q=beta/)
	await expect(page.getByText(betaListing.description)).toBeVisible()
	await expect(page.getByRole('link', { name: alphaListing.name })).toHaveCount(
		0,
	)
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	await page.goto('/community?q=beta')
	await expect(
		page.getByPlaceholder('Search by name, description, or tags'),
	).toHaveValue('beta')
	await expect(page.getByText(betaListing.description)).toBeVisible()
	await expect(page.getByRole('link', { name: alphaListing.name })).toHaveCount(
		0,
	)

	// A server-rendered 404 must not pin later SPA navigations to the
	// not-found fallback.
	const notFoundResponse = await page.goto('/definitely-not-a-page')
	expect(notFoundResponse?.status()).toBe(404)
	await expect(page.getByRole('heading', { name: 'Not Found' })).toBeVisible()
	await page.getByRole('link', { name: 'Community', exact: true }).click()
	await expect(page).toHaveURL(/\/community$/)
	await expect(page.getByText(betaListing.description)).toBeVisible()
	await expect(page.getByRole('heading', { name: 'Not Found' })).toHaveCount(0)
})
