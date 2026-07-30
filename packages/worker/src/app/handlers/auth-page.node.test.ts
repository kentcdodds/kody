import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () =>
		new Response('login-page', {
			status: 200,
			headers: { 'Content-Type': 'text/html' },
		}),
}))

function createStaleSessionTestEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind() {
						return {
							async all() {
								if (
									normalizedQuery.startsWith('select') &&
									normalizedQuery.includes('from "users"')
								) {
									return { results: [], meta: { changes: 0 } }
								}
								if (normalizedQuery.includes('from user_roles ur')) {
									return { results: [], meta: { changes: 0 } }
								}
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
	} as Env
}

test('auth page renders login for a stale session instead of redirecting away', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'f'.repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const handler = createAuthPageHandler(createStaleSessionTestEnv(), 'login')
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/login?redirectTo=%2Faccount', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(200)
	expect(await response.text()).toBe('login-page')
})
