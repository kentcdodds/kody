import { expect, test } from 'vitest'
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
