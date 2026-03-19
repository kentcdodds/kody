import { expect, test } from '@playwright/test'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test('logs in with email and password', async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()
	await page.goto('/login')

	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('heading', { name: `Welcome, ${primaryTestUser.email}` }),
	).toBeVisible()
})

test('logs in with a remembered 30-day session', async ({ page }) => {
	await ensurePrimaryUserExists(page.request)
	await page.context().clearCookies()
	await page.goto('/login')

	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByLabel('Remember me').check()
	await page.getByRole('button', { name: 'Sign in' }).click()

	await expect(page).toHaveURL(/\/account$/)
	const sessionCookie = (await page.context().cookies()).find(
		(cookie) => cookie.name === 'kody_session',
	)
	expect(sessionCookie).toBeDefined()
	const secondsUntilExpiry =
		(sessionCookie?.expires ?? 0) - Math.floor(Date.now() / 1000)
	expect(secondsUntilExpiry).toBeGreaterThan(60 * 60 * 24 * 28)
	expect(secondsUntilExpiry).toBeLessThanOrEqual(60 * 60 * 24 * 31)
})

test('rejects signup for non-primary email', async ({ page }) => {
	const signupUser = {
		email: `new-user-${crypto.randomUUID()}@example.com`,
		password: primaryTestUser.password,
	}
	await page.goto('/signup')

	await page.getByLabel('Email').fill(signupUser.email)
	await page.getByLabel('Password').fill(signupUser.password)
	await page.getByRole('button', { name: 'Create account' }).click()

	await expect(page).toHaveURL(/\/signup$/)
	await expect(
		page.getByText(`Only ${primaryTestUser.email} can sign in or sign up.`),
	).toBeVisible()
})

test('auth navigation keeps the URL and form mode in sync', async ({
	page,
}) => {
	await page.context().clearCookies()
	await page.goto('/login')

	const marker = await page.evaluate(() => {
		const value = crypto.randomUUID()
		;(window as Window & { __authNavMarker?: string }).__authNavMarker = value
		return value
	})

	await page.getByRole('link', { name: 'Signup' }).click()
	await expect(page).toHaveURL(/\/signup$/)
	await expect(
		page.getByRole('heading', { name: 'Create your account' }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Create account' }),
	).toBeVisible()
	await expect(page.getByLabel('Remember me')).toHaveCount(0)
	expect(
		await page.evaluate(
			() => (window as Window & { __authNavMarker?: string }).__authNavMarker,
		),
	).toBe(marker)

	await page.getByRole('link', { name: 'Login' }).click()
	await expect(page).toHaveURL(/\/login$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
	await expect(page.getByLabel('Remember me')).toBeVisible()

	await page.getByRole('link', { name: /Sign up instead/ }).click()
	await expect(page).toHaveURL(/\/signup$/)
	await expect(
		page.getByRole('heading', { name: 'Create your account' }),
	).toBeVisible()

	await page.getByRole('link', { name: /Sign in instead/ }).click()
	await expect(page).toHaveURL(/\/login$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
})
