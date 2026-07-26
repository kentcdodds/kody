import { expect, test } from './playwright-utils.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'

test('account activity shows filters for a seeded account', async ({
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
	await expect(page.getByLabel('Status filter')).toHaveValue('error')
	await expect(page.getByLabel('Surface filter')).toHaveValue('all')
	await expect(page.getByRole('link', { name: 'Activity' })).toBeVisible()
})
