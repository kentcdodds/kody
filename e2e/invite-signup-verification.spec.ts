import { expect, test } from './playwright-utils.ts'
import { setEmailVerificationTokenInE2eDatabase } from './d1-utils.ts'

test('admin invite signup and email verification happy path', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `invite-admin-${runId}@example.com`,
		username: `invite-admin-${runId}`,
		password: 'invite-admin-password',
	})
	const invitedEmail = `invite-user-${runId}@example.com`
	const invitedUsername = `invite-user-${runId}`
	const invitedPassword = 'invite-user-password'
	const inviteCode = `E2E-${runId}`
	const verificationToken = `verify-${runId}`

	await assignRole(adminUser.email, 'admin')
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})

	await page.goto('/admin/invites')
	await expect(
		page.getByRole('heading', { name: 'Admin invites' }),
	).toBeVisible()
	await page.getByLabel('Code').fill(inviteCode)
	await page.getByLabel('Note').fill('E2E invite signup verification')
	await page.getByLabel('Max uses').fill('1')
	await page.getByRole('button', { name: 'Create', exact: true }).click()
	await expect(page.getByText('Invite created.')).toBeVisible()
	await expect(page.getByRole('heading', { name: inviteCode })).toBeVisible()

	await page.context().clearCookies()
	await page.goto('/signup')
	await page.getByLabel('Username').fill(invitedUsername)
	await page.getByLabel('Email').fill(invitedEmail)
	await page.getByLabel('Password').fill(invitedPassword)
	await page.getByLabel('Invite code').fill(inviteCode)
	await page.getByRole('button', { name: 'Create account' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toBeVisible()
	await expect(
		page.getByText('Outbound email sending stays disabled'),
	).toBeVisible()

	await setEmailVerificationTokenInE2eDatabase({
		email: invitedEmail,
		token: verificationToken,
	})
	await page.goto(
		`/verify-email?token=${encodeURIComponent(verificationToken)}`,
	)
	await expect(
		page.getByRole('heading', { name: 'Email verified' }),
	).toBeVisible()
	await expect(
		page.getByText('Your email address has been verified.'),
	).toBeVisible()

	await page.goto('/account')
	await expect(
		page.getByText(`Email: ${invitedEmail} (verified)`),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toHaveCount(0)
})
