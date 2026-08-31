import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadSessionInfo } from '#app/session-info.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('loadSessionInfo signs out a deleting account and clears the session cookie', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'a'.repeat(64),
		email: 'deleting@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const env = {
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
										results: [
											{
												id: 7,
												email: 'deleting@example.com',
												username: 'deleting-user',
												stable_user_id: 'a'.repeat(64),
												deleting_at: '2026-08-31 15:00:00',
											},
										],
										meta: { changes: 0 },
									}
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

	const loaded = await loadSessionInfo(
		new Request('https://example.com/', { headers: { Cookie: cookie } }),
		env,
	)
	expect(loaded.session).toBeNull()
	expect(loaded.setCookie ?? '').toContain('kody_session=')
	expect(loaded.setCookie ?? '').toContain('Max-Age=0')
})
