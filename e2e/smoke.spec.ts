import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

test('smoke test covers shell, auth redirect, and login', async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()

	await page.goto('/')
	await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()

	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await expect(page.getByLabel('Email')).toBeVisible()
	await expect(page.getByLabel('Password')).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('link', {
			name: primaryTestUser.username,
		}),
	).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Secrets', exact: true }),
	).toBeVisible()

	// SPA-navigate to secrets: the client refetch must hit the same origin
	// (regression: absolute placeholder-origin URLs caused "Failed to fetch").
	await page.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/account\/secrets$/)
	await expect(
		page.getByRole('heading', { name: 'Saved secrets', exact: true }),
	).toBeVisible()
	await expect(page.getByText('Failed to fetch')).not.toBeVisible()

	await page.context().clearCookies()
	await page.goto('/privacy')
	await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'What a deployment admin can see' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'What an admin can never see' }),
	).toBeVisible()
})
