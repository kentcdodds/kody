import { expect, test } from 'vitest'
import { handleOidcLogoutRequest } from '#worker/oidc/logout.ts'

test('logout rejects post_logout_redirect_uri when OAuth helpers are unavailable', async () => {
	const response = await handleOidcLogoutRequest(
		new Request(
			'https://heykody.dev/oauth/logout?post_logout_redirect_uri=https://evil.example/cb&client_id=client-123',
		),
		{} as Env,
	)
	expect(response.status).toBe(400)
	expect(await response.text()).toMatch(/Invalid post_logout_redirect_uri/)
})
