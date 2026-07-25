import { expect, test } from './playwright-utils.ts'

test('verified user sees the account email inbox heading and address or empty list', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-email-${runId}@example.com`,
		username: `account-email-${runId}`,
		password: 'account-email-password',
	})
	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto('/account/email')
	await expect(
		page.getByRole('heading', { name: 'Email inbox', exact: true }),
	).toBeVisible()

	const inboxAddress = page.locator('text=/Inbox address:/i')
	const emptyList = page.getByText('No messages in your inbox yet.')
	await expect(inboxAddress.or(emptyList).first()).toBeVisible()
})
