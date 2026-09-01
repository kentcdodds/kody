import { expect, test } from 'vitest'
import { handleOidcUserinfoRequest } from '#worker/oidc/userinfo.ts'

function createOidcEnv(overrides: Partial<Env> = {}) {
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
		OAUTH_PROVIDER: {
			unwrapToken: async () => ({
				scope: ['openid', 'email', 'profile'],
				grant: {
					clientId: 'client-123',
					scope: ['openid', 'email', 'profile'],
					props: {
						userId: 'user-stable-id',
						email: 'user@example.com',
						username: 'test-user',
						displayName: 'test-user',
						authTime: 1_700_000_000,
					},
				},
			}),
		},
		...overrides,
	} as unknown as Env
}

test('userinfo returns claims for verified bearer tokens and 401 without bearer', async () => {
	const env = createOidcEnv()
	const okResponse = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: 'Bearer demo-token' },
		}),
		env,
	)
	expect(okResponse.status).toBe(200)
	await expect(okResponse.json()).resolves.toEqual({
		sub: 'user-stable-id',
		email: 'user@example.com',
		email_verified: true,
		preferred_username: 'test-user',
	})

	const unauthorized = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo'),
		env,
	)
	expect(unauthorized.status).toBe(401)
})

test('userinfo accepts POST with form access_token', async () => {
	const env = createOidcEnv()
	const response = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'access_token=demo-token',
		}),
		env,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		sub: 'user-stable-id',
	})
})

test('userinfo requires openid scope', async () => {
	const env = createOidcEnv({
		OAUTH_PROVIDER: {
			unwrapToken: async () => ({
				scope: ['email', 'profile'],
				grant: {
					clientId: 'client-123',
					scope: ['email', 'profile'],
					props: {
						userId: 'user-stable-id',
						email: 'user@example.com',
						username: 'test-user',
						displayName: 'test-user',
						authTime: 1_700_000_000,
					},
				},
			}),
		},
	} as Partial<Env>)
	const response = await handleOidcUserinfoRequest(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: 'Bearer demo-token' },
		}),
		env,
	)
	expect(response.status).toBe(403)
	await expect(response.json()).resolves.toMatchObject({
		error: 'insufficient_scope',
	})
})
