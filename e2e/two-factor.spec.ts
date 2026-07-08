import { generateTOTP } from '@epic-web/totp'
import { expect, test } from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

async function currentCodeFor(secret: string) {
	const { otp } = await generateTOTP({ secret })
	return otp
}

function wrongCodeFor(validCode: string) {
	// Flip the last digit so the wrong code can never collide with the
	// currently valid one.
	const lastDigit = Number(validCode.at(-1))
	return `${validCode.slice(0, -1)}${(lastDigit + 1) % 10}`
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

	// Enable 2FA from account settings.
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

	// A wrong code must not activate 2FA.
	const validSetupCode = await currentCodeFor(secret)
	await page.getByLabel('Verification code').fill(wrongCodeFor(validSetupCode))
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(page.getByText('Invalid code.')).toBeVisible()

	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(
		page.getByText('Two-factor authentication is enabled.'),
	).toBeVisible()

	// Logging in now requires the second factor before a session is issued.
	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto('/login')
	await page.getByLabel('Email').fill(user.email)
	await page.getByLabel('Password').fill(user.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()
	await expect(page).toHaveURL(/\/verify$/)

	// Without the code the user stays unauthenticated.
	const validLoginCode = await currentCodeFor(secret)
	await page.getByLabel('Verification code').fill(wrongCodeFor(validLoginCode))
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(page.getByText('Invalid code.')).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Verification code').fill(await currentCodeFor(secret))
	await page.getByRole('button', { name: 'Verify' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()

	// Disabling requires a fresh code; afterwards login goes straight through.
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

test('verify page without a pending two-factor login redirects to login', async ({
	page,
}) => {
	await page.context().clearCookies()
	await page.goto('/verify')
	await expect(page).toHaveURL(/\/login$/)
})
