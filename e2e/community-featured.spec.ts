import { expect, test } from './playwright-utils.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

test('admins can feature trusted listings and members see them in onboarding', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const trustedListingId = `e2e-featured-listing-${runId}`
	const trustedListingName = `@kody/featured-package-${runId}`
	const untrustedListingId = `e2e-unfeaturable-listing-${runId}`
	const adminUser = await seedE2eUser({
		email: `featured-admin-${runId}@example.com`,
		username: `featured-admin-${runId}`,
		password: 'featured-admin-password',
		admin: true,
	})
	const memberUser = await seedE2eUser({
		email: `featured-member-${runId}@example.com`,
		username: `featured-member-${runId}`,
		password: 'featured-member-password',
	})
	await seedCommunityListingInE2eDatabase({
		listingId: trustedListingId,
		ownerEmail: memberUser.email,
		name: trustedListingName,
		description: 'Trusted listing seeded for the featured e2e test.',
		tags: ['featured'],
		trusted: true,
	})
	await seedCommunityListingInE2eDatabase({
		listingId: untrustedListingId,
		ownerEmail: memberUser.email,
		name: `@kody/unfeaturable-package-${runId}`,
		description: 'Untrusted listing seeded for the featured e2e test.',
		tags: ['featured'],
	})

	// Non-admin members never see the featuring controls.
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${trustedListingId}`)
	await expect(page.getByText('Fork with your agent')).toBeVisible()
	await expect(page.getByTestId('community-admin-feature')).toHaveCount(0)

	// Without any featured listings, onboarding falls back to the browse CTA.
	await page.goto('/onboarding')
	await expect(
		page.getByRole('heading', { name: 'Explore community packages' }),
	).toBeVisible()
	await expect(page.getByTestId('onboarding-starter-packages')).toHaveCount(0)

	// Admins can feature the trusted listing from the detail page.
	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${trustedListingId}`)
	await expect(page.getByTestId('community-admin-feature')).toBeVisible()
	await page.getByRole('button', { name: 'Feature in onboarding' }).click()
	await expect(
		page.getByRole('button', { name: 'Remove from onboarding' }),
	).toBeVisible()
	await expect(
		page.getByTestId('community-detail-featured-badge'),
	).toBeVisible()

	// Untrusted listings cannot be featured: the button stays disabled.
	await page.goto(`/community/${untrustedListingId}`)
	await expect(
		page.getByRole('button', { name: 'Feature in onboarding' }),
	).toBeDisabled()

	// Members now see the featured listing as an onboarding starter package.
	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/onboarding')
	await expect(page.getByTestId('onboarding-starter-packages')).toBeVisible()
	const starterLink = page.getByTestId(`onboarding-starter-${trustedListingId}`)
	await expect(starterLink).toBeVisible()
	await expect(starterLink).toContainText(trustedListingName)
	await starterLink.click()
	await expect(page).toHaveURL(new RegExp(`/community/${trustedListingId}$`))
	await expect(
		page.getByRole('button', { name: 'Install', exact: true }),
	).toBeVisible()

	// Removing the mark pulls the listing from onboarding again.
	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${trustedListingId}`)
	await page.getByRole('button', { name: 'Remove from onboarding' }).click()
	await expect(
		page.getByRole('button', { name: 'Feature in onboarding' }),
	).toBeVisible()
	await expect(page.getByTestId('community-detail-featured-badge')).toHaveCount(
		0,
	)
	await page.goto('/onboarding')
	await expect(
		page.getByRole('heading', { name: 'Explore community packages' }),
	).toBeVisible()
	await expect(page.getByTestId('onboarding-starter-packages')).toHaveCount(0)
})
