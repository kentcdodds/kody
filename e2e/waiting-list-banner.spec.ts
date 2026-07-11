import { expect, test } from '@playwright/test'

test('top waitlist banner joins from the home page', async ({ page }) => {
	await page.goto('/')
	const banner = page.getByRole('region', { name: 'Join the waiting list' })
	await expect(banner).toBeVisible()
	await banner.getByPlaceholder('First name').fill('Ada')
	await banner
		.getByPlaceholder('Email')
		.fill(`waitlist-banner-${Date.now()}@example.com`)
	await banner.getByRole('button', { name: 'Join' }).click()
	await expect(
		banner.getByText("You're on the list. We'll be in touch."),
	).toBeVisible()
})

test('top waitlist banner is hidden on signup', async ({ page }) => {
	await page.goto('/signup')
	await expect(
		page.getByRole('region', { name: 'Join the waiting list' }),
	).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: 'Join the waiting list' }),
	).toBeVisible()
})
