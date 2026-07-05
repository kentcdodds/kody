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
	await ensurePrimaryUserExists(request)
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

	const htmlResponse = await request.get('/community')
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
	const communityScrollY = await page.evaluate(() => window.scrollY)
	expect(communityScrollY).toBeGreaterThan(0)

	await page.getByRole('link', { name: alphaListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${alphaListing.listingId}$`),
	)
	await expect(page.getByText(alphaListing.description)).toBeVisible()
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	await page.evaluate(() => window.scrollTo(0, 40))
	const detailScrollY = await page.evaluate(() => window.scrollY)
	expect(detailScrollY).toBeGreaterThan(0)
	expect(detailScrollY).not.toBe(communityScrollY)
	expect(communityScrollY).toBeGreaterThan(detailScrollY + 20)
	await page.goBack()
	await expect(page).toHaveURL(/\/community$/)
	await expect
		.poll(() => page.evaluate(() => window.scrollY))
		.toBeGreaterThan(detailScrollY + 20)

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
