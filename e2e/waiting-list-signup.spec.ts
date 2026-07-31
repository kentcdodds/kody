import { expect, test } from '@playwright/test'

test('waiting list signup from home banner and signup page', async ({
	page,
}) => {
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

	await page.goto('/signup?panel=waiting-list')
	await expect(
		page.getByRole('region', { name: 'Join the waiting list' }),
	).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: 'Join the waiting list' }),
	).toBeVisible()
	await page.getByLabel('First name').fill('Grace')
	await page.getByLabel('Email').fill(`waitlist-${Date.now()}@example.com`)
	await page.getByRole('button', { name: 'Join waiting list' }).click()
	await expect(
		page.getByText("You're on the list. We'll be in touch."),
	).toBeVisible()

	await page.getByRole('button', { name: 'I have a code' }).click()
	await expect(
		page.getByRole('heading', { name: 'Create your account' }),
	).toBeVisible()
	await expect(page.getByLabel('Invite code')).toBeVisible()
	await page
		.getByRole('button', { name: 'Join the waiting list instead' })
		.click()
	await expect(
		page.getByRole('heading', { name: 'Join the waiting list' }),
	).toBeVisible()
})
