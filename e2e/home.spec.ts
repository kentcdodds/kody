import { expect, test } from '@playwright/test'

test('home page renders the shell', async ({ page }) => {
	await page.goto('/')
	await expect(page).toHaveTitle('kody')
	await expect(
		page.getByRole('heading', { name: /meet kody/i }),
	).toBeVisible()
})

test('login link navigates without full page reload', async ({ page }) => {
	await page.goto('/')
	const loginLink = page.getByRole('link', { name: 'Login' })
	await expect(loginLink).toBeVisible()

	const marker = await page.evaluate(() => {
		const value = `spa-${Math.random().toString(16).slice(2)}`
		;(window as { __spaMarker?: string }).__spaMarker = value
		return value
	})

	await loginLink.click()
	await expect(page).toHaveURL(/\/login$/)
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()

	const markerAfterNavigation = await page.evaluate(
		() => (window as { __spaMarker?: string }).__spaMarker ?? null,
	)
	expect(markerAfterNavigation).toBe(marker)
})
