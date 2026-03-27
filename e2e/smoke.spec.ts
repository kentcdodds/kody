import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test('smoke test covers shell, auth redirect, and login', async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()

	await page.goto('/')
	await expect(page).toHaveTitle('kody')
	await expect(page.getByRole('heading', { name: /meet kody/i })).toBeVisible()

	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()

	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('heading', {
			name: `${primaryTestUser.email} account`,
		}),
	).toBeVisible()
	await expect(
		page.getByRole('link', {
			name: 'Manage secrets',
		}),
	).toBeVisible()
})
