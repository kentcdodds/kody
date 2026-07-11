import { expect, test } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	setEmailVerificationTokenInE2eDatabase,
} from './d1-utils.ts'

test('admin invite signup and email verification happy path', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `invite-admin-${runId}@example.com`,
		username: `invite-admin-${runId}`,
		password: 'invite-admin-password',
		admin: true,
	})
	const invitedEmail = `invite-user-${runId}@example.com`
	const invitedUsername = `invite-user-${runId}`
	const invitedPassword = 'invite-user-password'
	const inviteCode = `E2E-${runId}`
	const verificationToken = `verify-${runId}`
	const adminCreatedEmail = `admin-created-${runId}@example.com`
	const adminCreatedUsername = `admin-created-${runId}`
	const adminCreatedPassword = 'admin-created-password'

	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})

	// Parallel E2E workers share one local D1 file; auth/admin reads can
	// briefly return 500 while another worker is writing fixtures.
	await expect(async () => {
		await page.goto('/admin/invites')
		await expect(
			page.getByRole('heading', { name: 'Admin invites' }),
		).toBeVisible({ timeout: 1_000 })
	}).toPass({ timeout: 15_000 })
	await page.getByLabel('Code').fill(inviteCode)
	await page.getByLabel('Note').fill('E2E invite signup verification')
	await page.getByLabel('Max uses').fill('1')
	await page.getByRole('button', { name: 'Create', exact: true }).click()
	await expect(async () => {
		await expect(page.getByRole('heading', { name: inviteCode })).toBeVisible({
			timeout: 1_000,
		})
	}).toPass({ timeout: 15_000 })

	await page.getByLabel('User email').fill(adminCreatedEmail)
	await page.getByLabel('Username (optional)').fill(adminCreatedUsername)
	await expect(async () => {
		await page.getByRole('button', { name: 'Create user', exact: true }).click()
		await expect(
			page.getByRole('link', { name: 'Open setup link' }),
		).toBeVisible({ timeout: 1_000 })
	}).toPass({ timeout: 15_000 })
	const setupLink =
		(await page
			.getByRole('link', { name: 'Open setup link' })
			.getAttribute('href')) ?? ''
	expect(setupLink).toContain('/reset-password?token=')

	await page.context().clearCookies()
	await page.goto(setupLink)
	await expect(
		page.getByRole('heading', { name: 'Choose a new password' }),
	).toBeVisible()
	await page.getByLabel('New password').fill(adminCreatedPassword)
	clearAuthRateLimitsInE2eDatabase()
	await page.getByRole('button', { name: 'Update password' }).click()
	await page.goto('/login')
	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Email').fill(adminCreatedEmail)
	await page.getByLabel('Password').fill(adminCreatedPassword)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByText(`Email: ${adminCreatedEmail} (verified)`),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toHaveCount(0)

	await page.context().clearCookies()
	await page.goto('/signup')
	clearAuthRateLimitsInE2eDatabase()
	await page.getByRole('button', { name: 'I have a code' }).click()
	await page.getByLabel('Username').fill(invitedUsername)
	await page.getByLabel('Email').fill(invitedEmail)
	await page.getByLabel('Password').fill(invitedPassword)
	await page.getByLabel('Invite code').fill(inviteCode)
	await page.getByRole('button', { name: 'Create account' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toBeVisible()

	await page.getByRole('button', { name: 'Resend verification email' }).click()
	await expect(async () => {
		await setEmailVerificationTokenInE2eDatabase({
			email: invitedEmail,
			token: verificationToken,
		})
		await page.goto(
			`/verify-email?token=${encodeURIComponent(verificationToken)}`,
		)
		await expect(
			page.getByRole('heading', { name: 'Email verified' }),
		).toBeVisible({ timeout: 1_000 })
	}).toPass({ timeout: 15_000 })

	await page.goto('/account')
	await expect(
		page.getByText(`Email: ${invitedEmail} (verified)`),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toHaveCount(0)
})
