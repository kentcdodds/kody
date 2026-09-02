import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	deleteUserInE2eDatabase,
} from './d1-utils.ts'
import {
	extractVerifyEmailPath,
	findVerificationEmail,
	listE2eCloudflareMockMessages,
	type MockEmailMessage,
} from './cloudflare-mock.ts'

const mcpInitializeBody = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-03-26',
		capabilities: {},
		clientInfo: { name: 'kody-e2e', version: '0.0.0' },
	},
}

async function postUnauthenticatedMcpInitialize(origin: string) {
	return fetch(new URL('/mcp', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json, text/event-stream',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(mcpInitializeBody),
	})
}

test('a new user signs up, verifies email from the message, and reaches MCP connect', async ({
	page,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 45_000)
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const email = `e2e-signup-${runId}@example.com`
	const username = `e2e-su-${runId}`
	const password = 'e2e-signup-password'

	clearAuthRateLimitsInE2eDatabase()
	await page.context().clearCookies()

	try {
		await page.goto('/signup')
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: 'Create your account' }),
		).toBeVisible()
		await expect(
			page.getByText(/By creating an account you agree to the/),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: 'Terms of Service' }),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: 'Privacy Policy' }),
		).toBeVisible()

		await page.getByLabel('Username').fill(username)
		await page.getByLabel('Email').fill(email)
		await page.getByLabel('Password').fill(password)
		await page.getByRole('button', { name: 'Create account' }).click()

		await expect(page).toHaveURL(
			/\/pending-verification(?:\?accountCreated=1)?$/,
		)
		await expect(
			page.getByRole('heading', { name: 'Check your email' }),
		).toBeVisible()
		await expect(
			page.getByRole('region', { name: 'Email verification status' }),
		).toBeVisible()
		await expect(page.getByText(email, { exact: false })).toBeVisible()

		const sessionBefore = await page.request.get('/session')
		expect(sessionBefore.ok()).toBe(true)
		const sessionBeforeBody = (await sessionBefore.json()) as {
			ok?: boolean
			session?: { email?: string; emailVerified?: boolean }
		}
		expect(sessionBeforeBody.ok).toBe(true)
		expect(sessionBeforeBody.session?.email).toBe(email)
		expect(sessionBeforeBody.session?.emailVerified).toBe(false)

		await page.goto('/onboarding')
		await expect(page).toHaveURL(/\/pending-verification/)
		await expect(
			page.getByRole('heading', { name: 'Check your email' }),
		).toBeVisible()

		const mcpBeforeVerify = await postUnauthenticatedMcpInitialize(origin)
		expect(mcpBeforeVerify.status).toBe(401)
		expect(mcpBeforeVerify.headers.get('www-authenticate') ?? '').toMatch(
			/resource_metadata="[^"]*\/.well-known\/oauth-protected-resource"/,
		)

		let verificationEmail: MockEmailMessage | null = null
		await expect
			.poll(
				async () => {
					const payload = await listE2eCloudflareMockMessages()
					verificationEmail = findVerificationEmail(payload.messages, email)
					return verificationEmail
				},
				{ timeout: 15_000 },
			)
			.not.toBeNull()
		const emailBody = `${verificationEmail?.text ?? ''}\n${verificationEmail?.html ?? ''}`
		const verifyPath = extractVerifyEmailPath(emailBody)
		if (!verifyPath) {
			throw new Error(
				'Verification email did not contain a /verify-email?token= link.',
			)
		}

		await page.goto(verifyPath)
		await expect(
			page.getByRole('heading', { name: 'Email verified' }),
		).toBeVisible()
		await expect(
			page.getByRole('link', { name: 'Continue to onboarding' }),
		).toBeVisible()

		const sessionAfter = await page.request.get('/session')
		expect(sessionAfter.ok()).toBe(true)
		const sessionAfterBody = (await sessionAfter.json()) as {
			ok?: boolean
			session?: { email?: string; emailVerified?: boolean }
		}
		expect(sessionAfterBody.ok).toBe(true)
		expect(sessionAfterBody.session?.email).toBe(email)
		expect(sessionAfterBody.session?.emailVerified).toBe(true)

		await page.getByRole('link', { name: 'Continue to onboarding' }).click()
		await expect(page).toHaveURL(/\/onboarding/)
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: /Get started with\s*Kody/i }),
		).toBeVisible()

		const checklist = page.getByRole('region', { name: 'Onboarding checklist' })
		await expect(checklist).toBeVisible()
		const verifyItem = checklist.getByRole('listitem').filter({
			hasText: 'Verify your email',
		})
		await expect(verifyItem).toHaveAttribute('data-done', 'true')

		await page
			.locator(
				'[data-testid="onboarding-agent-picker"] ul[data-surface="desktop"]',
			)
			.getByRole('link', { name: 'Claude Code', exact: true })
			.click()
		await expect(page).toHaveURL(/[?&]agent=claude-code/)
		const mcpUrl = `${origin}/mcp`
		await expect(
			page.getByTestId('onboarding-agent-instructions'),
		).toContainText(mcpUrl)
		await expect(
			page.getByTestId('onboarding-authenticate-callout'),
		).toBeVisible()

		const mcpAfterVerify = await postUnauthenticatedMcpInitialize(origin)
		expect(mcpAfterVerify.status).toBe(401)
		expect(mcpAfterVerify.headers.get('www-authenticate') ?? '').toMatch(
			/^Bearer\s+/,
		)
		expect(mcpAfterVerify.headers.get('www-authenticate') ?? '').toContain(
			`${origin}/.well-known/oauth-protected-resource`,
		)
	} finally {
		deleteUserInE2eDatabase(email)
	}
})
