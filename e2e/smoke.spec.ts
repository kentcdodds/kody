import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test('smoke test covers shell, auth redirect, and login', async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()

	await page.goto('/')
	await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
	await expect(page.getByRole('img', { name: 'kody logo' })).toBeVisible()

	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await expect(page.getByLabel('Email')).toBeVisible()
	await expect(page.getByLabel('Password')).toBeVisible()

	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('link', {
			name: primaryTestUser.email,
		}),
	).toBeVisible()
	await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible()
	await expect(
		page.getByRole('link', { name: primaryTestUser.email }),
	).toHaveAttribute('href', '/account/secrets')
})
