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

test('SSR community HTML hydrates SPA navigation and client search', async ({
	page,
	request,
}) => {
	await ensurePrimaryUserExists(request)
	await seedCommunityListingInE2eDatabase({
		...alphaListing,
		ownerEmail: primaryTestUser.email,
	})
	await seedCommunityListingInE2eDatabase({
		...betaListing,
		ownerEmail: primaryTestUser.email,
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

	await page.evaluate(() => {
		;(window as Window & { __e2eMarker?: boolean }).__e2eMarker = true
	})

	await page.getByRole('link', { name: alphaListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${alphaListing.listingId}$`),
	)
	await expect(page.getByText(alphaListing.description)).toBeVisible()
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	await page.getByRole('link', { name: 'Community', exact: true }).click()
	await expect(page).toHaveURL(/\/community$/)
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

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
