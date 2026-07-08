import { afterEach, beforeEach, expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createSocialAuthStartHandler } from '#app/handlers/social-auth.ts'
import { installSocialAuthMockFetch } from '#app/social-auth-mock.ts'
import {
	readOAuthTransaction,
	setOAuthTransactionSecret,
} from '#app/oauth-transaction.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createSocialAuthTestEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		APP_DB: {
			prepare() {
				return {
					bind() {
						return {
							async all() {
								return { results: [], meta: { changes: 0 } }
							},
							async first() {
								return null
							},
							async run() {
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
		SENTRY_ENVIRONMENT: 'test',
	} as Env
}

function createHandlerContext(request: Request, provider: string) {
	const url = new URL(request.url)
	return {
		request,
		params: { provider },
		url,
	} as never
}

function readSetCookies(response: Response) {
	return response.headers.getSetCookie?.() ?? []
}

function readCookieValue(setCookies: Array<string>, name: string) {
	const cookie = setCookies.find((value) => value.startsWith(`${name}=`))
	if (!cookie) return null
	return cookie.split(';')[0] ?? null
}

let restoreMockFetch: (() => void) | undefined

beforeEach(() => {
	setAuthSessionSecret(testCookieSecret)
	setOAuthTransactionSecret(testCookieSecret)
	restoreMockFetch = installSocialAuthMockFetch()
})

afterEach(() => {
	restoreMockFetch?.()
	restoreMockFetch = undefined
})

test('social auth start redirects to GitHub and stores an OAuth transaction cookie', async () => {
	const env = createSocialAuthTestEnv()
	const startHandler = createSocialAuthStartHandler(env)
	const request = new Request(
		'https://example.com/auth/github?redirectTo=%2Faccount',
	)
	const response = await startHandler.handler(
		createHandlerContext(request, 'github'),
	)

	expect(response.status).toBe(302)
	const location = response.headers.get('Location')
	expect(location).toContain('github.com/login/oauth/authorize')
	const transactionCookie = readCookieValue(
		readSetCookies(response),
		'kody_oauth_transaction',
	)
	expect(transactionCookie).not.toBeNull()

	const transaction = await readOAuthTransaction(
		new Request('https://example.com/auth/github', {
			headers: { Cookie: transactionCookie! },
		}),
	)
	expect(transaction?.provider).toBe('github')
	expect(transaction?.returnTo).toBe('/account')
})
