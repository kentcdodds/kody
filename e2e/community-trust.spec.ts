import { expect, test } from './playwright-utils.ts'
import { seedCommunityListingInE2eDatabase } from './d1-utils.ts'

test('admins can toggle listing trust and everyone sees the badge', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const listingId = `e2e-trust-listing-${runId}`
	const listingName = `@kody/trust-package-${runId}`
	const adminUser = await seedE2eUser({
		email: `trust-admin-${runId}@example.com`,
		username: `trust-admin-${runId}`,
		password: 'trust-admin-password',
		admin: true,
	})
	const memberUser = await seedE2eUser({
		email: `trust-member-${runId}@example.com`,
		username: `trust-member-${runId}`,
		password: 'trust-member-password',
	})
	await seedCommunityListingInE2eDatabase({
		listingId,
		ownerEmail: memberUser.email,
		name: listingName,
		description: 'Listing seeded for the trust badge e2e test.',
		tags: ['trust'],
	})

	// Non-admin members never see the trust controls and cannot hit the API.
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${listingId}`)
	await expect(page.getByText('Fork with your agent')).toBeVisible()
	await expect(page.getByTestId('community-admin-trust')).toHaveCount(0)
	await expect(page.getByTestId('community-detail-trusted-badge')).toHaveCount(
		0,
	)
	const memberTrustResponse = await page.request.post(
		`/community/${listingId}/trust.json`,
		{
			data: { trusted: true },
			headers: { 'Content-Type': 'application/json' },
		},
	)
	expect(memberTrustResponse.status()).toBe(403)

	// Admins can mark the listing trusted from the detail page.
	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto(`/community/${listingId}`)
	await expect(page.getByTestId('community-admin-trust')).toBeVisible()
	await page.getByRole('button', { name: 'Mark as trusted' }).click()
	await expect(page.getByRole('button', { name: 'Revoke trust' })).toBeVisible()
	await expect(page.getByTestId('community-detail-trusted-badge')).toBeVisible()

	// The badge also shows on the community index card for everyone.
	await page.goto('/community')
	await expect(
		page.getByTestId(`community-listing-trusted-${listingId}`),
	).toBeVisible()

	// Revoking removes the badge again.
	await page.goto(`/community/${listingId}`)
	await page.getByRole('button', { name: 'Revoke trust' }).click()
	await expect(
		page.getByRole('button', { name: 'Mark as trusted' }),
	).toBeVisible()
	await expect(page.getByTestId('community-detail-trusted-badge')).toHaveCount(
		0,
	)
})
