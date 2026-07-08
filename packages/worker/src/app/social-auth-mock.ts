import  {
	type GitHubAuthProfile,
	type GoogleAuthProfile,
	type XAuthProfile,
} from 'remix/auth'

export const mockSocialAuthAccessToken = 'mock-social-auth-access-token'
export const mockSocialAuthAuthorizationCode = 'mock-social-auth-code'

export const mockGitHubProfile: GitHubAuthProfile = {
	id: 424242,
	login: 'mock-github-user',
	name: 'Mock GitHub User',
	email: 'mock-github@example.com',
}

export const mockGoogleProfile: GoogleAuthProfile = {
	sub: 'mock-google-subject',
	email: 'mock-google@example.com',
	email_verified: true,
	name: 'Mock Google User',
	picture: 'https://example.com/mock-google.png',
}

export const mockXProfile: XAuthProfile = {
	id: 'mock-x-user-id',
	username: 'mockxuser',
	name: 'Mock X User',
}

type MockFetchHandler = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function readRequestUrl(input: RequestInfo | URL) {
	if (typeof input === 'string') return new URL(input)
	if (input instanceof URL) return input
	return new URL(input.url)
}

function createGitHubMockHandler(): MockFetchHandler {
	return (input) => {
		const url = readRequestUrl(input)
		if (url.pathname === '/login/oauth/access_token') {
			return jsonResponse({
				access_token: mockSocialAuthAccessToken,
				token_type: 'bearer',
				scope: 'read:user user:email',
			})
		}
		if (url.pathname === '/user') {
			return jsonResponse(mockGitHubProfile)
		}
		if (url.pathname === '/user/emails') {
			return jsonResponse([
				{
					email: mockGitHubProfile.email,
					primary: true,
					verified: true,
				},
			])
		}
		return new Response('Not found', { status: 404 })
	}
}

function createGoogleMockHandler(): MockFetchHandler {
	return (input) => {
		const url = readRequestUrl(input)
		if (url.pathname === '/token') {
			return jsonResponse({
				access_token: mockSocialAuthAccessToken,
				token_type: 'Bearer',
				scope: 'openid email profile',
			})
		}
		if (url.pathname === '/v1/userinfo') {
			return jsonResponse(mockGoogleProfile)
		}
		return new Response('Not found', { status: 404 })
	}
}

function createXMockHandler(): MockFetchHandler {
	return (input) => {
		const url = readRequestUrl(input)
		if (url.pathname === '/2/oauth2/token') {
			return jsonResponse({
				access_token: mockSocialAuthAccessToken,
				token_type: 'bearer',
				scope: 'users.read tweet.read',
			})
		}
		if (url.pathname === '/2/users/me') {
			return jsonResponse({ data: mockXProfile })
		}
		return new Response('Not found', { status: 404 })
	}
}

function matchesHost(url: URL, host: string) {
	return url.hostname === host || url.hostname.endsWith(`.${host}`)
}

/**
 * Intercepts provider HTTP calls during tests and local mock mode so social
 * login can run without real OAuth app credentials.
 */
export function installSocialAuthMockFetch(): () => void {
	const originalFetch = globalThis.fetch

	globalThis.fetch = (async (input, init) => {
		const url = readRequestUrl(input)

		if (matchesHost(url, 'github.com')) {
			return createGitHubMockHandler()(input, init)
		}
		if (matchesHost(url, 'googleapis.com')) {
			return createGoogleMockHandler()(input, init)
		}
		if (matchesHost(url, 'api.x.com')) {
			return createXMockHandler()(input, init)
		}

		return originalFetch(input, init)
	}) as typeof fetch

	return () => {
		globalThis.fetch = originalFetch
	}
}
