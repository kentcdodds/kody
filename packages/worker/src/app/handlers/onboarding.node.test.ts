import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
} from '#app/handlers/onboarding.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/onboarding-data.ts', () => ({
	loadOnboardingData: vi.fn(async () => ({
		ok: true,
		mcpServerUrl: 'https://example.com/mcp',
		setupPrompt: 'Help me get started with Kody.',
		hasMcpClient: false,
		needsOnboarding: true,
	})),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async () => new Response('ok')),
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

test('onboarding handler redirects to login with a session-destroy cookie for stale sessions', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		id: '99',
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const handler = createOnboardingHandler(createStaleSessionTestEnv())
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/onboarding', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Fonboarding',
	)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})

test('onboarding API returns 401 for anonymous requests', async () => {
	setAuthSessionSecret(testCookieSecret)
	const handler = createOnboardingApiHandler(createStaleSessionTestEnv())
	const response = await handler.handler(
		new RequestContext(new Request('https://example.com/onboarding.json')),
	)
	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
})
