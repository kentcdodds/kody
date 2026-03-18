import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test.beforeEach(async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()
})

test('redirects unauthenticated account to login with redirectTo', async ({
	page,
}) => {
	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
})

test('redirects authenticated user from login to account', async ({ page }) => {
	await page.goto('/login')
	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)

	await page.goto('/login')
	await expect(page).toHaveURL(/\/account$/)
})

test('logs out from the account page', async ({ page }) => {
	await page.goto('/login')
	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	const marker = await page.evaluate(() => {
		const value = `form-spa-${Math.random().toString(16).slice(2)}`
		;(window as { __formSpaMarker?: string }).__formSpaMarker = value
		return value
	})
	await page.getByRole('button', { name: 'Log out' }).click()

	await expect(page).toHaveURL(/\/login$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
	await expect(page.getByRole('link', { name: 'Login' })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0)
	const markerAfterLogout = await page.evaluate(
		() => (window as { __formSpaMarker?: string }).__formSpaMarker ?? null,
	)
	expect(markerAfterLogout).toBe(marker)
})
