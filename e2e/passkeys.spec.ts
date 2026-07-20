import { generateTOTP } from '@epic-web/totp'
import { type Page, expect, test } from './playwright-utils.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

// WebAuthn relying party ids must be domains, not IP addresses, so passkey
// tests navigate via localhost instead of the default 127.0.0.1 base URL.
// The login fixture already registers the session cookie for localhost.
function localhostUrl(baseURL: string | undefined, pathname: string) {
	const url = new URL(pathname, baseURL ?? 'http://127.0.0.1:3847')
	url.hostname = 'localhost'
	return url.toString()
}

async function addVirtualAuthenticator(page: Page) {
	const client = await page.context().newCDPSession(page)
	await client.send('WebAuthn.enable')
	await client.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	})
}

test('passkey lifecycle: register, sign in, delete', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `passkey-${runId}@example.com`,
		username: `passkey-${runId}`,
		password: 'passkey-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await addVirtualAuthenticator(page)

	// Register a passkey from account settings.
	await page.goto(localhostUrl(baseURL, '/account/passkeys'))
	await expect(
		page.getByRole('heading', { name: 'No passkeys yet' }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Register a passkey' }).click()
	await expect(page.getByText('Passkey registered.')).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Registered passkeys' }),
	).toBeVisible()
	const passkeyList = page.getByRole('list').filter({
		has: page.getByRole('button', { name: 'Rename' }),
	})
	await expect(passkeyList.getByText(/Created /)).toBeVisible()
	await expect(passkeyList.getByText('Last used Never')).toBeVisible()

	// Rename so multiple passkeys stay distinguishable.
	await page.getByRole('button', { name: 'Rename' }).click()
	await page.getByLabel('Passkey nickname').fill('Josh phone')
	await page.getByRole('button', { name: 'Save' }).click()
	await expect(page.getByText('Passkey renamed.')).toBeVisible()
	await expect(passkeyList.getByText('Josh phone')).toBeVisible()

	// Sign in with the passkey instead of the password.
	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto(localhostUrl(baseURL, '/login'))
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()

	// Delete the passkey.
	await page.goto(localhostUrl(baseURL, '/account/passkeys'))
	await expect(passkeyList.getByText('Josh phone')).toBeVisible()
	await expect(passkeyList.getByText(/Last used /)).toBeVisible()
	await expect(passkeyList.getByText('Last used Never')).toHaveCount(0)
	await page.getByRole('button', { name: 'Delete' }).click()
	await expect(page.getByText('Passkey deleted.')).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'No passkeys yet' }),
	).toBeVisible()
})

test('passkey sign-in skips TOTP when two-factor is enabled', async ({
	page,
	seedE2eUser,
	login,
	baseURL,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `passkey-2fa-${runId}@example.com`,
		username: `passkey-2fa-${runId}`,
		password: 'passkey-2fa-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await addVirtualAuthenticator(page)

	// Enable 2FA.
	await page.goto(localhostUrl(baseURL, '/account/two-factor'))
	await page.getByRole('button', { name: 'Enable 2FA' }).click()
	const secret = (await page.getByTestId('totp-secret').textContent()) ?? ''
	expect(secret.length).toBeGreaterThan(0)
	await page
		.getByLabel('Verification code')
		.fill((await generateTOTP({ secret })).otp)
	await page.getByRole('button', { name: 'Confirm' }).click()
	await expect(
		page.getByText('Two-factor authentication is enabled.'),
	).toBeVisible()

	// Register a passkey.
	await page.goto(localhostUrl(baseURL, '/account/passkeys'))
	await page.getByRole('button', { name: 'Register a passkey' }).click()
	await expect(page.getByText('Passkey registered.')).toBeVisible()

	// A verified passkey already satisfies MFA, so skip the TOTP challenge.
	await page.context().clearCookies()
	clearAuthRateLimitsInE2eDatabase()
	await page.goto(localhostUrl(baseURL, '/login'))
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByText(`Email: ${user.email}`)).toBeVisible()
})
