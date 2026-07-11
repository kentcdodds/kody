import { expect, test } from '@playwright/test'

test('signup waiting list form joins without an invite code', async ({
	page,
}) => {
	await page.goto('/signup')
	await expect(
		page.getByRole('heading', { name: 'Join the waiting list' }),
	).toBeVisible()
	await page.getByLabel('First name').fill('Ada')
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
