import { generateTOTP } from '@epic-web/totp'
import { expect, test } from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

async function currentCodeFor(secret: string) {
	const { otp } = await generateTOTP({ secret })
	return otp
}

test('two-factor lifecycle: enable, login with code, disable', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `two-factor-${runId}@example.com`,
		username: `two-factor-${runId}`,
		password: 'two-factor-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	await page.goto('/account/two-factor')
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is disabled',
		}),
	).toBeVisible()
	await page.getByRole('button', { name: 'Enable 2FA' }).click()
	await expect(
		page.getByRole('heading', { name: 'Scan this QR code' }),
	).toBeVisible()

	const secret = (await page.getByTestId('totp-secret').textContent()) ?? ''
	expect(secret.length).toBeGreaterThan(0)

	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(
		page.getByText('Two-factor authentication is enabled.'),
	).toBeVisible()

	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto('/login')
	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password').fill(user.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/verify$/)

	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()

	await page.goto('/account/two-factor')
	await expect(
		page.getByRole('heading', {
			name: 'Two-factor authentication is enabled',
		}),
	).toBeVisible()
	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Disable 2FA' }).click()
	await expect(
		page.getByText('Two-factor authentication is disabled.'),
	).toBeVisible()

	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto('/login')
	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password').fill(user.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/account$/)
})
