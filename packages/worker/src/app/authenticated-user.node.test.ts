import { expect, test } from 'vitest'
import { readAuthenticatedAppUser } from './authenticated-user.ts'

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
