import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from './auth-session.ts'
import { readAuthenticatedAppUser } from './authenticated-user.ts'

const testCookieSecret = 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'

test('readAuthenticatedAppUser only requires the session cookie secret from env', async () => {
	const user = await readAuthenticatedAppUser(
		new Request('https://example.com/account/secrets.json'),
		{
			COOKIE_SECRET: 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
			REMOTE_CONNECTOR_SECRETS: {
				'custom:alpha': 'alpha-secret',
			},
		} as unknown as Env,
	)

	expect(user).toBeNull()
})

test('readAuthenticatedAppUser rejects partially numeric session ids', async () => {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{
			id: '1abc',
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)

	const user = await readAuthenticatedAppUser(
		new Request('https://example.com/account/profile.json', {
			headers: {
				Cookie: cookie,
			},
		}),
		{
			APP_DB: createAuthenticatedUserTestDb(),
			COOKIE_SECRET: testCookieSecret,
		} as Env,
	)

	expect(user).toBeNull()
})

function createAuthenticatedUserTestDb() {
	return {
		prepare() {
			throw new Error('Malformed session id should not query users.')
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

test('readAuthenticatedAppUser fails closed to empty roles when the rbac query errors', async () => {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{
			id: '7',
			email: 'user@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind() {
					return {
						async all() {
							if (normalizedQuery.includes('from "users"')) {
								return {
									results: [
										{
											id: 7,
											email: 'user@example.com',
											username: 'resilient-user',
											password_hash: 'irrelevant',
										},
									],
									meta: { changes: 0 },
								}
							}
							if (normalizedQuery.includes('from user_roles')) {
								throw new Error('D1 unavailable')
							}
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)
	try {
		const user = await readAuthenticatedAppUser(
			new Request('https://example.com/session', {
				headers: { Cookie: cookie },
			}),
			{ APP_DB: db, COOKIE_SECRET: testCookieSecret } as Env,
		)

		expect(user).not.toBeNull()
		expect(user?.username).toBe('resilient-user')
		expect(user?.roles).toEqual([])
		expect(user?.permissions).toEqual([])
		expect(consoleError).toHaveBeenCalled()
	} finally {
		consoleError.mockRestore()
	}
})
