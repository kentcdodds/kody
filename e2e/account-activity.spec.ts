import { expect, test } from './playwright-utils.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test('account activity shows empty state and filters for a seeded account', async ({
	page,
	login,
}) => {
	await ensurePrimaryUserExists()
	await login({
		email: primaryTestUser.email,
		password: primaryTestUser.password,
		mode: 'login',
	})

	await page.goto('/account/activity')
	await expect(
		page.getByRole('heading', { name: 'Activity', exact: true }),
	).toBeVisible()
	await expect(page.getByLabel('Status filter')).toBeVisible()
	await expect(page.getByLabel('Surface filter')).toBeVisible()
	await expect(page.getByLabel('Status filter')).toHaveValue('error')
	await expect(page.getByLabel('Surface filter')).toHaveValue('all')
	await expect(
		page.getByText(
			'No failures in the last 7 days. That is good news — when something breaks, it will show up here with its logs.',
		),
	).toBeVisible()
	await expect(
		page.getByText(
			'Successful ad-hoc execute runs are not recorded (only failures are).',
		),
	).toBeVisible()
	await expect(page.getByRole('link', { name: 'Activity' })).toBeVisible()
})
