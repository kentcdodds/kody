import { expect, test } from '@playwright/test'
import {
	clearAuthRateLimitsInE2eDatabase,
	executeE2eD1Command,
} from './d1-utils.ts'

// The test wrangler env ships MOCK_ social-login client ids, so the full
// start -> provider -> callback redirect round-trip runs in-worker against
// canned mock provider profiles (no provider apps or network needed).
test('social login signs in via mock GitHub and manages connections', async ({
	page,
}) => {
	executeE2eD1Command(
		`DELETE FROM oauth_connections WHERE provider_id IN ('mock-github-user-1', 'mock-google-user-1', 'mock-x-user-1'); DELETE FROM users WHERE email IN ('mock-github-user@example.com', 'mock-google-user@example.com');`,
	)
	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	await page.goto('/login')
	await expect(
		page.getByRole('button', { name: 'Continue with Google' }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Continue with X' }),
	).toBeVisible()

	await page.getByRole('button', { name: 'Continue with GitHub' }).click()

	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('heading', { name: 'mock-github-user account' }),
	).toBeVisible()
	// The provider-verified email skips the verification-email flow entirely.
	await expect(
		page.getByText('Email: mock-github-user@example.com (verified)'),
	).toBeVisible()

	// The connections card lists the GitHub identity; it is the account's
	// only sign-in method (no password), so disconnect stays disabled.
	const connectionsCard = page.getByRole('region', {
		name: 'Connected accounts',
	})
	await expect(
		connectionsCard.getByText('Connected as mock-github-user'),
	).toBeVisible()
	await expect(
		connectionsCard.getByRole('button', { name: 'Disconnect' }),
	).toBeDisabled()

	// Connecting Google while signed in links it to this account without
	// logging out.
	clearAuthRateLimitsInE2eDatabase()
	await connectionsCard.getByRole('button', { name: 'Connect Google' }).click()
	await expect(page).toHaveURL(/\/account\?oauthLinked=google$/)
	await expect(page.getByText('Google connected.')).toBeVisible()
	await expect(
		connectionsCard.getByText('Google', { exact: true }),
	).toBeVisible()

	// With two connections, disconnecting one is allowed again.
	const googleRow = connectionsCard
		.getByRole('listitem')
		.filter({ hasText: 'Google' })
	await googleRow.getByRole('button', { name: 'Disconnect' }).click()
	await expect(page.getByText('Google disconnected.')).toBeVisible()
	await expect(
		connectionsCard.getByText('Google', { exact: true }),
	).not.toBeVisible()
	await expect(
		connectionsCard.getByRole('button', { name: 'Connect Google' }),
	).toBeVisible()
})
