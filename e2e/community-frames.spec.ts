import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import {
	seedCommunityForkInE2eDatabase,
	seedCommunityListingInE2eDatabase,
	updateCommunityListingDescriptionInE2eDatabase,
} from './d1-utils.ts'

const staleListing = {
	listingId: 'e2e-frame-stale-listing',
	name: '@kody/frame-stale-package',
	description: 'Original description before back-navigation.',
	tags: ['stale', 'frame'],
}

test('community listing and detail frames reload fresh data on back-navigation', async ({
	page,
}) => {
	await ensurePrimaryUserExists()
	await seedCommunityListingInE2eDatabase({
		...staleListing,
		ownerEmail: primaryTestUser.email,
	})

	await page.goto('/community')
	await expect(
		page.getByTestId(`community-listing-description-${staleListing.listingId}`),
	).toHaveText(staleListing.description)
	await page.waitForFunction(
		() => window.history.scrollRestoration === 'manual',
	)

	await page.evaluate(() => {
		;(window as Window & { __e2eStaleMarker?: boolean }).__e2eStaleMarker = true
	})

	await page.getByRole('link', { name: staleListing.name }).click()
	await expect(page).toHaveURL(
		new RegExp(`/community/${staleListing.listingId}$`),
	)

	const updatedDescription = 'Updated description after detail visit.'
	updateCommunityListingDescriptionInE2eDatabase({
		listingId: staleListing.listingId,
		description: updatedDescription,
	})

	const listingsFrameReload = page.waitForResponse(
		(response) =>
			response.request().headers()['x-remix-target'] === 'community-listings' &&
			response.url().includes('/community') &&
			response.status() === 200,
	)

	await page.getByRole('link', { name: 'Community packages' }).click()
	await expect(page).toHaveURL(/\/community$/)
	await listingsFrameReload

	await expect(
		page.getByTestId(`community-listing-description-${staleListing.listingId}`),
	).toHaveText(updatedDescription)
	expect(
		await page.evaluate(
			() =>
				(window as Window & { __e2eStaleMarker?: boolean }).__e2eStaleMarker,
		),
	).toBe(true)

	const detailListingId = 'e2e-frame-detail-stale-listing'
	await seedCommunityListingInE2eDatabase({
		...staleListing,
		listingId: detailListingId,
		name: '@kody/frame-detail-stale-package',
		ownerEmail: primaryTestUser.email,
	})

	await page.goto(`/community/${detailListingId}`)
	const initialForkCount = Number(
		(await page.getByTestId('community-detail-forks').textContent()) ?? '0',
	)
	await page.waitForFunction(
		() => window.history.scrollRestoration === 'manual',
	)

	await page.evaluate(() => {
		;(window as Window & { __e2eDetailMarker?: boolean }).__e2eDetailMarker =
			true
	})

	await page.getByRole('link', { name: 'Community packages' }).click()
	await expect(page).toHaveURL(/\/community$/)

	await seedCommunityForkInE2eDatabase({
		listingId: detailListingId,
		forkerEmail: primaryTestUser.email,
		forkId: `fork-${detailListingId}-${Date.now()}`,
	})

	const detailFrameReload = page.waitForResponse(
		(response) =>
			response.request().headers()['x-remix-target'] === 'community-detail' &&
			response.url().includes(`/community/${detailListingId}`) &&
			response.status() === 200,
	)

	await page
		.getByRole('link', { name: '@kody/frame-detail-stale-package' })
		.click()
	await expect(page).toHaveURL(new RegExp(`/community/${detailListingId}$`))
	await detailFrameReload

	await expect(page.getByTestId('community-detail-forks')).toHaveText(
		String(initialForkCount + 1),
	)
	expect(
		await page.evaluate(
			() =>
				(window as Window & { __e2eDetailMarker?: boolean }).__e2eDetailMarker,
		),
	).toBe(true)
})
