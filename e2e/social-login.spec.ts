import { expect, test } from './playwright-utils.ts'
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
	await page.getByRole('button', { name: 'Continue with GitHub' }).click()

	// A brand-new social account lands on onboarding rather than the account
	// page, matching where password signups go after verification.
	await expect(page).toHaveURL(/\/onboarding$/)
	await expect(
		page.getByRole('heading', { name: /Get started with\s*Kody/i }),
	).toBeVisible()

	await page.goto('/account')
	await expect(
		page.getByRole('heading', { name: 'Account', exact: true }),
	).toBeVisible()
	// The redesign moved the verified state out of the sentence and into a pill
	// beside the address, so "(verified)" is no longer part of one contiguous
	// string. Assert the address and the pill separately.
	const emailNote = page.getByText('Email: mock-github-user@example.com')
	await expect(emailNote).toBeVisible()
	await expect(emailNote.getByText('verified')).toBeVisible()

	const connectionsCard = page.getByRole('region', {
		name: 'Connected accounts',
	})
	await expect(
		connectionsCard.getByText('Connected as mock-github-user'),
	).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await connectionsCard.getByRole('button', { name: 'Connect Google' }).click()
	await expect(page).toHaveURL(/\/account\?oauthLinked=google$/)
	await expect(page.getByText('Google connected.')).toBeVisible()
	const googleRow = connectionsCard
		.getByRole('listitem')
		.filter({ hasText: 'Google' })
	await expect(googleRow).toBeVisible()
	await expect(
		googleRow.getByText('Connected as Mock Google User'),
	).toBeVisible()
})
