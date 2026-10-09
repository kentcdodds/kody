import { expect, test } from 'vitest'
import { handleOidcUserinfoRequest } from '#worker/oidc/userinfo.ts'

function createOidcEnv(
	scope: string[] | null = ['openid', 'email', 'profile'],
) {
	return {
		APP_DB: {
			prepare() {
				return {
					bind() {
						return this
					},
					async first() {
						return { email_verified_at: new Date(0).toISOString() }
					},
				}
			},
		},
		OAUTH_PROVIDER: scope
			? {
					unwrapToken: async () => ({
						scope,
						grant: {
							clientId: 'client-123',
							scope,
							props: {
								userId: 'user-stable-id',
								email: 'user@example.com',
								username: 'test-user',
								displayName: 'test-user',
								authTime: 1_700_000_000,
							},
						},
					}),
				}
			: undefined,
	} as unknown as Env
}

function userinfo(env: Env, init?: RequestInit) {
	return handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', init),
		env,
	)
}

const bearer = { headers: { Authorization: 'Bearer demo-token' } }

test('userinfo returns claims for verified bearer tokens and 401 without bearer', async () => {
	const env = createOidcEnv()
	const okResponse = await userinfo(env, bearer)
	expect(okResponse.status).toBe(200)
	await expect(okResponse.json()).resolves.toEqual({
		sub: 'user-stable-id',
		email: 'user@example.com',
		email_verified: true,
		preferred_username: 'test-user',
	})
	expect((await userinfo(env)).status).toBe(401)
})

test('userinfo accepts POST with form access_token', async () => {
	const response = await userinfo(createOidcEnv(), {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'access_token=demo-token',
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		sub: 'user-stable-id',
	})
})

test('userinfo requires openid scope and 401s when OAuth helpers are unavailable', async () => {
	for (const [scope, status, error] of [
		[['email', 'profile'], 403, 'insufficient_scope'],
		[null, 401, 'invalid_token'],
	] as const) {
		const response = await userinfo(createOidcEnv(scope && [...scope]), bearer)
		expect(response.status).toBe(status)
		await expect(response.json()).resolves.toMatchObject({ error })
	}
})
