import { expect, test } from './playwright-utils.ts'
import {
	executeE2eD1Command,
	seedCommunityListingInE2eDatabase,
} from './d1-utils.ts'

test('admins can feature trusted listings and members see them in onboarding', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const trustedListingId = `e2e-featured-listing-${runId}`
	const trustedListingName = `@kody/featured-package-${runId}`
	const untrustedListingId = `e2e-unfeaturable-listing-${runId}`
	// Clear leftover featured marks from interrupted prior runs so this test
	// starts from an empty onboarding starter list.
	executeE2eD1Command(
		'UPDATE community_listings SET featured_at = NULL WHERE featured_at IS NOT NULL;',
	)
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

	// Without any featured listings, onboarding still shows the starter step
	// with the Choose your own adventure card.
	await page.goto('/onboarding')
	await expect(page.getByTestId('onboarding-starter-packages')).toBeVisible()
	await expect(page.getByTestId('onboarding-diy-card')).toBeVisible()
	await expect(page.getByTestId('onboarding-diy-copy')).toBeVisible()

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

	// Members now see the featured listing as an onboarding starter package
	// and can install it without leaving /onboarding. Mock install JSON: local
	// e2e lacks Cloudflare credentials for repo-backed source persistence.
	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.route(
		(url) => url.pathname === `/community/${trustedListingId}/install.json`,
		async (route) => {
			if (route.request().method() !== 'POST') {
				await route.continue()
				return
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ok: true,
					status: 'installed',
					packageId: 'pkg-e2e-onboarding-install',
					sourceId: 'src-e2e-onboarding-install',
					targetName: `@${memberUser.username}/featured-package-${runId}`,
					agentPrompt:
						'Finish setup for the installed onboarding starter package.',
				}),
			})
		},
	)
	await page.goto('/onboarding')
	await expect(page.getByTestId('onboarding-starter-packages')).toBeVisible()
	const starterCard = page.getByTestId(`onboarding-starter-${trustedListingId}`)
	await expect(starterCard).toBeVisible()
	await expect(starterCard).toContainText(trustedListingName)
	await expect(page.getByTestId('onboarding-diy-card')).toBeVisible()
	await page
		.getByTestId(`onboarding-starter-install-${trustedListingId}`)
		.click()
	await expect(
		page.getByTestId(`onboarding-starter-copy-${trustedListingId}`),
	).toBeVisible()
	await expect(
		page.getByTestId(`onboarding-starter-status-${trustedListingId}`),
	).toContainText('Installed as')
	await expect(
		page.getByTestId(`onboarding-starter-copy-${trustedListingId}`),
	).toHaveText('Copy prompt')
	await starterCard.getByRole('link', { name: trustedListingName }).click()
	await expect(page).toHaveURL(new RegExp(`/community/${trustedListingId}$`))

	// Removing the mark pulls the listing from onboarding again; DIY remains.
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
	await expect(page.getByTestId('onboarding-starter-packages')).toBeVisible()
	await expect(
		page.getByTestId(`onboarding-starter-${trustedListingId}`),
	).toHaveCount(0)
	await expect(page.getByTestId('onboarding-diy-card')).toBeVisible()
})
