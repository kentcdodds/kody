import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createPendingVerificationHandler } from '#app/handlers/pending-verification.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

function createUserEnv(options: {
	emailVerifiedAt?: string | null
	missingUser?: boolean
}) {
	const user = options.missingUser
		? null
		: {
				id: 1,
				email: 'pending@example.com',
				username: 'pending-user',
				password_hash: 'unused',
				email_verified_at: options.emailVerifiedAt ?? null,
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			}
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
									return {
										results: user ? [user] : [],
										meta: { changes: 0 },
									}
								}
								if (normalizedQuery.includes('from user_roles ur')) {
									return { results: [], meta: { changes: 0 } }
								}
								return { results: [], meta: { changes: 0 } }
							},
							async first() {
								if (normalizedQuery.includes('email_verified_at')) {
									return user
										? { email_verified_at: user.email_verified_at }
										: null
								}
								return user
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

test('pending verification requires a live session, preserves redirectTo after verify, and renders when unverified', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		id: '1',
		email: 'pending@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)

	const anonymousResponse = await createPendingVerificationHandler(
		createUserEnv({}),
	).handler(
		new RequestContext(new Request('https://example.com/pending-verification')),
	)
	expect(anonymousResponse.status).toBe(302)
	expect(anonymousResponse.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Fpending-verification',
	)

	const pendingResponse = await createPendingVerificationHandler(
		createUserEnv({ emailVerifiedAt: null }),
	).handler(
		new RequestContext(
			new Request('https://example.com/pending-verification', {
				headers: { Cookie: cookie },
			}),
		),
	)
	expect(pendingResponse.status).toBe(200)
	await expect(pendingResponse.json()).resolves.toEqual({
		ok: true,
		loaderData: {
			pendingVerification: {
				ok: true,
				email: 'pending@example.com',
			},
		},
	})

	const verifiedResponse = await createPendingVerificationHandler(
		createUserEnv({ emailVerifiedAt: new Date(0).toISOString() }),
	).handler(
		new RequestContext(
			new Request('https://example.com/pending-verification', {
				headers: { Cookie: cookie },
			}),
		),
	)
	expect(verifiedResponse.status).toBe(302)
	expect(verifiedResponse.headers.get('Location')).toBe(
		'https://example.com/onboarding',
	)

	const verifiedWithRedirect = await createPendingVerificationHandler(
		createUserEnv({ emailVerifiedAt: new Date(0).toISOString() }),
	).handler(
		new RequestContext(
			new Request(
				'https://example.com/pending-verification?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Ddemo',
				{ headers: { Cookie: cookie } },
			),
		),
	)
	expect(verifiedWithRedirect.status).toBe(302)
	expect(verifiedWithRedirect.headers.get('Location')).toBe(
		'https://example.com/oauth/authorize?client_id=demo',
	)

	const verifiedRejectsOpenRedirect = await createPendingVerificationHandler(
		createUserEnv({ emailVerifiedAt: new Date(0).toISOString() }),
	).handler(
		new RequestContext(
			new Request(
				'https://example.com/pending-verification?redirectTo=https%3A%2F%2Fevil.example',
				{ headers: { Cookie: cookie } },
			),
		),
	)
	expect(verifiedRejectsOpenRedirect.status).toBe(302)
	expect(verifiedRejectsOpenRedirect.headers.get('Location')).toBe(
		'https://example.com/onboarding',
	)
})
