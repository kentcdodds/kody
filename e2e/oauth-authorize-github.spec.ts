import { createHash, randomBytes } from 'node:crypto'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import {
	clearAuthRateLimitsInE2eDatabase,
	executeE2eD1Command,
} from './d1-utils.ts'
import { buildDeleteUserAndPersonalOrgSql } from '../tools/seed-sql.ts'

const mockGithubEmail = 'mock-github-user@example.com'
const callbackRedirectUri = 'https://example.com/oauth/callback'

function createS256CodeChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url')
}

function createCodeVerifier() {
	return randomBytes(32).toString('base64url')
}

async function resetMockGithubUser() {
	executeE2eD1Command(
		`DELETE FROM oauth_connections WHERE provider_id = 'mock-github-user-1';
${buildDeleteUserAndPersonalOrgSql({
	emails: [mockGithubEmail],
	orphanPersonalOrgSlugs: ['mock-octo'],
})}`,
	)
	clearAuthRateLimitsInE2eDatabase()
}

async function registerPublicClient(
	request: import('@playwright/test').APIRequestContext,
) {
	const response = await request.post('/oauth/register', {
		data: {
			redirect_uris: [callbackRedirectUri],
			client_name: 'E2E GitHub Authorize Client',
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		},
	})
	expect(response.ok()).toBeTruthy()
	const payload = (await response.json()) as { client_id: string }
	expect(payload.client_id).toBeTruthy()
	return payload.client_id
}

function buildAuthorizePath(input: {
	clientId: string
	verifier: string
	state: string
	prompt?: string
}) {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: input.clientId,
		redirect_uri: callbackRedirectUri,
		scope: 'profile email',
		code_challenge: createS256CodeChallenge(input.verifier),
		code_challenge_method: 'S256',
		state: input.state,
	})
	if (input.prompt) params.set('prompt', input.prompt)
	return `/oauth/authorize?${params.toString()}`
}

test('GitHub-only account authorizes while already signed in', async ({
	page,
	request,
}) => {
	await resetMockGithubUser()
	await page.context().clearCookies()

	await page.goto('/login')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Continue with GitHub' }).click()
	await expect(page).toHaveURL(/\/onboarding\/step-1\?accountCreated=1$/)

	const clientId = await registerPublicClient(request)
	const verifier = createCodeVerifier()
	const state = `signed-in-${createCodeVerifier()}`
	const authorizePath = buildAuthorizePath({ clientId, verifier, state })

	await page.goto(authorizePath)
	await waitForClientHydration(page)

	await expect(
		page.getByRole('heading', { name: 'Authorize access' }),
	).toBeVisible()
	await expect(page.getByText(/Signed in as/i)).toBeVisible()
	await expect(page.locator('input[name="password"]')).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'Continue with GitHub' }),
	).toHaveCount(0)

	await page.getByTestId('oauth-authorize-approve').click()
	await expect(page).toHaveURL(
		new RegExp(
			`^${callbackRedirectUri.replace(/\./g, '\\.')}\\?.*code=.*state=${state}`,
		),
	)
})

test('GitHub sign-in from authorize returns with OAuth params intact', async ({
	page,
	request,
}) => {
	await resetMockGithubUser()
	await page.context().clearCookies()

	const clientId = await registerPublicClient(request)
	const verifier = createCodeVerifier()
	const state = `from-authorize-${createCodeVerifier()}`
	const authorizePath = buildAuthorizePath({
		clientId,
		verifier,
		state,
		prompt: 'login',
	})

	await page.goto(authorizePath)
	await waitForClientHydration(page)

	await expect(
		page.getByRole('heading', { name: 'Authorize access' }),
	).toBeVisible()
	await expect(page.locator('input[name="password"]')).toBeVisible()
	const githubButton = page.getByRole('button', {
		name: 'Continue with GitHub',
	})
	await expect(githubButton).toBeVisible()

	await githubButton.click()

	// New GitHub account still resumes authorize (explicit redirectTo wins);
	// prompt=login is stripped after the completed social auth.
	await expect(page).toHaveURL(/\/oauth\/authorize\?/)
	await expect(page).not.toHaveURL(/prompt=login/)
	await expect(page).toHaveURL(new RegExp(`client_id=${clientId}`))
	await expect(page).toHaveURL(new RegExp(`state=${state}`))
	await expect(page).toHaveURL(
		new RegExp(`redirect_uri=${encodeURIComponent(callbackRedirectUri)}`),
	)
	await expect(page).toHaveURL(/code_challenge=/)
	await expect(page).toHaveURL(/code_challenge_method=S256/)

	await waitForClientHydration(page)
	await expect(page.getByText(/Signed in as/i)).toBeVisible()
	await expect(page.locator('input[name="password"]')).toHaveCount(0)

	await page.getByTestId('oauth-authorize-approve').click()
	await expect(page).toHaveURL(
		new RegExp(
			`^${callbackRedirectUri.replace(/\./g, '\\.')}\\?.*code=.*state=${state}`,
		),
	)
})
