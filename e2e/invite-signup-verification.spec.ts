import { expect, test } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	setEmailVerificationTokenInE2eDatabase,
} from './d1-utils.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')

function queryUserPlanFromE2eDatabase(email: string) {
	const result = spawnSync(
		process.execPath,
		[
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--persist-to',
			'.wrangler/state/e2e',
			'--json',
			'--command',
			`SELECT plan FROM users WHERE email = ${quoteSqlString(email)};`,
		],
		{
			cwd: projectRoot,
			encoding: 'utf8',
			stdio: 'pipe',
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		},
	)
	if (result.status !== 0) {
		throw new Error(
			`Failed to query user plan from E2E D1:\n${result.stdout}\n${result.stderr}`,
		)
	}
	const parsed = JSON.parse(result.stdout) as Array<{
		results?: Array<{ plan: string | null }>
	}>
	const rows = parsed.flatMap((entry) => entry.results ?? [])
	return rows[0]?.plan ?? null
}

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
	await page.getByLabel('Plan').selectOption('pro')
	await page.getByRole('button', { name: 'Create', exact: true }).click()
	await expect(async () => {
		await expect(page.getByRole('heading', { name: inviteCode })).toBeVisible({
			timeout: 1_000,
		})
	}).toPass({ timeout: 15_000 })
	// Filter to visible matches: the create form's <select> also contains a
	// hidden <option> with the same text.
	await expect(
		page.getByText('pro', { exact: true }).filter({ visible: true }).first(),
	).toBeVisible()

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
	await expect(page).toHaveURL(/\/pending-verification$/)
	await expect(
		page.getByRole('heading', { name: 'Check your email' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Add Kody as an MCP server' }),
	).toHaveCount(0)
	await expect(page.getByText(/\/mcp/)).toHaveCount(0)

	await page.goto(
		`/onboarding?redirectTo=${encodeURIComponent('/oauth/authorize?client_id=e2e-onboarding')}`,
	)
	await expect(page).toHaveURL(
		/\/pending-verification\?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3De2e-onboarding$/,
	)
	await expect(
		page.getByRole('heading', { name: 'Add Kody as an MCP server' }),
	).toHaveCount(0)

	await page.getByRole('button', { name: 'Resend verification email' }).click()
	const oauthResume = '/oauth/authorize?client_id=e2e-demo&response_type=code'
	await expect(async () => {
		await setEmailVerificationTokenInE2eDatabase({
			email: invitedEmail,
			token: verificationToken,
		})
		await page.goto(
			`/verify-email?token=${encodeURIComponent(verificationToken)}&redirectTo=${encodeURIComponent(oauthResume)}`,
		)
		await expect(
			page.getByRole('heading', { name: 'Email verified' }),
		).toBeVisible({ timeout: 1_000 })
	}).toPass({ timeout: 15_000 })

	await expect(page.getByText(/MCP access is now available/i)).toBeVisible()
	const continueAuthorization = page.getByRole('link', {
		name: 'Continue authorization',
	})
	await expect(continueAuthorization).toHaveAttribute('href', oauthResume)
	await continueAuthorization.click()
	await expect(page).toHaveURL(/\/oauth\/authorize/)

	await page.goto('/onboarding')
	await expect(page).toHaveURL(/\/onboarding$/)
	await expect(
		page.getByRole('heading', { name: 'Add Kody as an MCP server' }),
	).toBeVisible()
	await expect(
		page.getByRole('tablist', { name: 'MCP client setup instructions' }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Copy MCP URL' }).first(),
	).toBeVisible()

	await page.goto('/account')
	await expect(
		page.getByText(`Email: ${invitedEmail} (verified)`),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Verify your email' }),
	).toHaveCount(0)

	expect(queryUserPlanFromE2eDatabase(invitedEmail)).toBe('pro')
})
