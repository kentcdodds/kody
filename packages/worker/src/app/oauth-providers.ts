import { isNonProductionRuntime } from '#app/deployment-env.ts'

/**
 * Social login ("Sign in with ...") OAuth 2.0 consumer support.
 *
 * This is deliberately separate from the other two OAuth subsystems:
 * Kody-as-provider MCP OAuth (`packages/worker/src/oauth-handlers.ts`) and
 * outbound integration OAuth (`/connect/oauth`). Here Kody is a confidential
 * OAuth client of GitHub, Google, and X for user authentication only; no
 * provider access tokens are persisted.
 */
export const oauthProviderIds = ['github', 'google', 'x'] as const
export type OauthProviderId = (typeof oauthProviderIds)[number]

export function isOauthProviderId(value: string): value is OauthProviderId {
	return (oauthProviderIds as ReadonlyArray<string>).includes(value)
}

export type OauthProfile = {
	providerUserId: string
	/** Email as reported by the provider, or null when the provider does not share one. */
	email: string | null
	/** True only when the provider asserts it verified the email address. */
	emailVerified: boolean
	username: string | null
	displayName: string | null
}

export type OauthProviderEnv = {
	GITHUB_CLIENT_ID?: string | undefined
	GITHUB_CLIENT_SECRET?: string | undefined
	GOOGLE_CLIENT_ID?: string | undefined
	GOOGLE_CLIENT_SECRET?: string | undefined
	X_CLIENT_ID?: string | undefined
	X_CLIENT_SECRET?: string | undefined
	WRANGLER_IS_LOCAL_DEV?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
}

type OauthProviderDefinition = {
	label: string
	authorizationEndpoint: string
	tokenEndpoint: string
	scope: string
	/**
	 * GitHub OAuth apps ignore PKCE, so it stays state-only; Google supports
	 * S256 and X requires it.
	 */
	usesPkce: boolean
	/** X wants client credentials via HTTP Basic; GitHub and Google take body params. */
	tokenAuthStyle: 'body' | 'basic'
}

export const oauthProviderDefinitions: Record<
	OauthProviderId,
	OauthProviderDefinition
> = {
	github: {
		label: 'GitHub',
		authorizationEndpoint: 'https://github.com/login/oauth/authorize',
		tokenEndpoint: 'https://github.com/login/oauth/access_token',
		scope: 'read:user user:email',
		usesPkce: false,
		tokenAuthStyle: 'body',
	},
	google: {
		label: 'Google',
		authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenEndpoint: 'https://oauth2.googleapis.com/token',
		scope: 'openid email profile',
		usesPkce: true,
		tokenAuthStyle: 'body',
	},
	x: {
		label: 'X',
		authorizationEndpoint: 'https://x.com/i/oauth2/authorize',
		tokenEndpoint: 'https://api.x.com/2/oauth2/token',
		// users.read requires tweet.read; users.email unlocks confirmed_email
		// when "Request email from users" is enabled on the X app.
		scope: 'tweet.read users.read users.email',
		usesPkce: true,
		tokenAuthStyle: 'basic',
	},
}

const oauthClientEnvKeys: Record<
	OauthProviderId,
	{ clientId: keyof OauthProviderEnv; clientSecret: keyof OauthProviderEnv }
> = {
	github: {
		clientId: 'GITHUB_CLIENT_ID',
		clientSecret: 'GITHUB_CLIENT_SECRET',
	},
	google: {
		clientId: 'GOOGLE_CLIENT_ID',
		clientSecret: 'GOOGLE_CLIENT_SECRET',
	},
	x: { clientId: 'X_CLIENT_ID', clientSecret: 'X_CLIENT_SECRET' },
}

function readEnvValue(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export function getOauthClientConfig(
	env: OauthProviderEnv,
	provider: OauthProviderId,
) {
	const keys = oauthClientEnvKeys[provider]
	const clientId = readEnvValue(env[keys.clientId])
	const clientSecret = readEnvValue(env[keys.clientSecret])
	if (!clientId || !clientSecret) return null
	return { clientId, clientSecret }
}

export function getEnabledOauthProviders(env: OauthProviderEnv) {
	return oauthProviderIds.filter((provider) =>
		Boolean(getOauthClientConfig(env, provider)),
	)
}

/**
 * Epic Stack-style mocking: a `MOCK_`-prefixed client id short-circuits the
 * whole provider round-trip with a canned profile so local dev and E2E tests
 * can exercise the full redirect flow without provider apps or network
 * access. Fails closed: mock mode never activates on a production runtime.
 */
export function isMockOauthProvider(
	env: OauthProviderEnv,
	provider: OauthProviderId,
) {
	const config = getOauthClientConfig(env, provider)
	if (!config) return false
	return config.clientId.startsWith('MOCK_') && isNonProductionRuntime(env)
}

const mockAuthorizationCode = 'kody-mock-oauth-code'

export function getMockOauthProfile(provider: OauthProviderId): OauthProfile {
	switch (provider) {
		case 'github':
			return {
				providerUserId: 'mock-github-user-1',
				email: 'mock-github-user@example.com',
				emailVerified: true,
				username: 'mock-github-user',
				displayName: 'Mock GitHub User',
			}
		case 'google':
			return {
				providerUserId: 'mock-google-user-1',
				email: 'mock-google-user@example.com',
				emailVerified: true,
				username: null,
				displayName: 'Mock Google User',
			}
		case 'x':
			// X only shares confirmed_email when the app has email permission;
			// the mock mirrors the common no-email case.
			return {
				providerUserId: 'mock-x-user-1',
				email: null,
				emailVerified: false,
				username: 'mock-x-user',
				displayName: 'Mock X User',
			}
		default: {
			const exhaustiveCheck: never = provider
			throw new Error(`Unhandled OAuth provider: ${String(exhaustiveCheck)}`)
		}
	}
}

function base64UrlEncode(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateOauthRandomValue() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return base64UrlEncode(bytes)
}

export async function createPkceCodeChallenge(codeVerifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(codeVerifier),
	)
	return base64UrlEncode(new Uint8Array(digest))
}

export async function buildAuthorizeRedirectUrl(input: {
	env: OauthProviderEnv
	provider: OauthProviderId
	state: string
	codeVerifier: string
	redirectUri: string
}) {
	const { env, provider, state, codeVerifier, redirectUri } = input
	const config = getOauthClientConfig(env, provider)
	if (!config) {
		throw new Error(`OAuth provider not configured: ${provider}`)
	}

	if (isMockOauthProvider(env, provider)) {
		const mockRedirect = new URL(redirectUri)
		mockRedirect.searchParams.set('code', mockAuthorizationCode)
		mockRedirect.searchParams.set('state', state)
		return mockRedirect.toString()
	}

	const definition = oauthProviderDefinitions[provider]
	const authorizeUrl = new URL(definition.authorizationEndpoint)
	authorizeUrl.searchParams.set('client_id', config.clientId)
	authorizeUrl.searchParams.set('redirect_uri', redirectUri)
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('scope', definition.scope)
	authorizeUrl.searchParams.set('state', state)
	if (definition.usesPkce) {
		authorizeUrl.searchParams.set(
			'code_challenge',
			await createPkceCodeChallenge(codeVerifier),
		)
		authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	}
	return authorizeUrl.toString()
}

// A hung provider endpoint must not pin the callback request open for the
// Worker's full wall-time budget.
const providerRequestTimeoutMs = 15_000

export class OauthProviderRequestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'OauthProviderRequestError'
	}
}

async function exchangeCodeForAccessToken(input: {
	env: OauthProviderEnv
	provider: OauthProviderId
	code: string
	codeVerifier: string
	redirectUri: string
}) {
	const { env, provider, code, codeVerifier, redirectUri } = input
	const config = getOauthClientConfig(env, provider)
	if (!config) {
		throw new OauthProviderRequestError(
			`OAuth provider not configured: ${provider}`,
		)
	}
	const definition = oauthProviderDefinitions[provider]

	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
	})
	if (definition.usesPkce) {
		body.set('code_verifier', codeVerifier)
	}
	const headers = new Headers({
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'application/json',
	})
	if (definition.tokenAuthStyle === 'basic') {
		headers.set(
			'Authorization',
			`Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
		)
	} else {
		body.set('client_id', config.clientId)
		body.set('client_secret', config.clientSecret)
	}

	const response = await fetch(definition.tokenEndpoint, {
		method: 'POST',
		headers,
		body: body.toString(),
		signal: AbortSignal.timeout(providerRequestTimeoutMs),
	})
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	const accessToken =
		payload && typeof payload.access_token === 'string'
			? payload.access_token
			: null
	if (!response.ok || !accessToken) {
		throw new OauthProviderRequestError(
			`OAuth token exchange failed for ${provider} (status ${response.status}).`,
		)
	}
	return accessToken
}

async function fetchProviderJson(url: string, accessToken: string) {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			// GitHub's API rejects requests without a User-Agent.
			'User-Agent': 'kody',
		},
		signal: AbortSignal.timeout(providerRequestTimeoutMs),
	})
	if (!response.ok) {
		throw new OauthProviderRequestError(
			`OAuth profile request failed (${url}, status ${response.status}).`,
		)
	}
	return (await response.json()) as unknown
}

function readString(record: unknown, key: string) {
	if (!record || typeof record !== 'object') return null
	const value = (record as Record<string, unknown>)[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

async function fetchGithubProfile(accessToken: string): Promise<OauthProfile> {
	const user = await fetchProviderJson(
		'https://api.github.com/user',
		accessToken,
	)
	const providerUserId =
		user && typeof user === 'object' && 'id' in user
			? String((user as Record<string, unknown>).id ?? '')
			: ''
	if (!providerUserId) {
		throw new OauthProviderRequestError('GitHub profile is missing an id.')
	}

	let email: string | null = null
	let emailVerified = false
	try {
		const emails = await fetchProviderJson(
			'https://api.github.com/user/emails',
			accessToken,
		)
		if (Array.isArray(emails)) {
			const primaryVerified = emails.find(
				(entry) =>
					entry &&
					typeof entry === 'object' &&
					(entry as Record<string, unknown>).primary === true &&
					(entry as Record<string, unknown>).verified === true,
			)
			email = readString(primaryVerified, 'email')
			emailVerified = Boolean(email)
		}
	} catch {
		// The user:email scope can be revoked per-user; fall back to the
		// public profile email (unverified).
	}
	if (!email) {
		email = readString(user, 'email')
		emailVerified = false
	}

	return {
		providerUserId,
		email,
		emailVerified,
		username: readString(user, 'login'),
		displayName: readString(user, 'name') ?? readString(user, 'login'),
	}
}

async function fetchGoogleProfile(accessToken: string): Promise<OauthProfile> {
	const user = await fetchProviderJson(
		'https://openidconnect.googleapis.com/v1/userinfo',
		accessToken,
	)
	const providerUserId = readString(user, 'sub')
	if (!providerUserId) {
		throw new OauthProviderRequestError('Google profile is missing a subject.')
	}
	const email = readString(user, 'email')
	const emailVerified =
		Boolean(email) &&
		Boolean(
			user &&
			typeof user === 'object' &&
			(user as Record<string, unknown>).email_verified === true,
		)
	return {
		providerUserId,
		email,
		emailVerified,
		username: null,
		displayName: readString(user, 'name'),
	}
}

async function fetchXProfile(accessToken: string): Promise<OauthProfile> {
	const payload = await fetchProviderJson(
		'https://api.x.com/2/users/me?user.fields=confirmed_email',
		accessToken,
	)
	const data =
		payload && typeof payload === 'object'
			? (payload as Record<string, unknown>).data
			: null
	const providerUserId = readString(data, 'id')
	if (!providerUserId) {
		throw new OauthProviderRequestError('X profile is missing an id.')
	}
	const email = readString(data, 'confirmed_email')
	return {
		providerUserId,
		email,
		// X only returns confirmed_email once the account email is confirmed.
		emailVerified: Boolean(email),
		username: readString(data, 'username'),
		displayName: readString(data, 'name') ?? readString(data, 'username'),
	}
}

/**
 * Runs the code-for-token exchange and profile fetch for a callback. In mock
 * mode this returns the canned profile without any network access.
 */
export async function resolveOauthProfile(input: {
	env: OauthProviderEnv
	provider: OauthProviderId
	code: string
	codeVerifier: string
	redirectUri: string
}): Promise<OauthProfile> {
	const { env, provider } = input
	if (isMockOauthProvider(env, provider)) {
		return getMockOauthProfile(provider)
	}

	const accessToken = await exchangeCodeForAccessToken(input)
	switch (provider) {
		case 'github':
			return fetchGithubProfile(accessToken)
		case 'google':
			return fetchGoogleProfile(accessToken)
		case 'x':
			return fetchXProfile(accessToken)
		default: {
			const exhaustiveCheck: never = provider
			throw new Error(`Unhandled OAuth provider: ${String(exhaustiveCheck)}`)
		}
	}
}
