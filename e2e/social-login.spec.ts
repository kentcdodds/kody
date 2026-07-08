import { expect, test } from '@playwright/test'
import {
	clearAuthRateLimitsInE2eDatabase,
	executeE2eD1Command,
} from './d1-utils.ts'

// The test wrangler env ships MOCK_ social-login client ids, so the full
// start -> provider -> callback redirect round-trip runs in-worker against
// the canned mock GitHub profile (no provider app or network needed).
test('social login signs in through the mock GitHub provider', async ({
	page,
}) => {
	executeE2eD1Command(
		`DELETE FROM oauth_connections WHERE provider_name = 'github' AND provider_id = 'mock-github-user-1'; DELETE FROM users WHERE email = 'mock-github-user@example.com';`,
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
})
