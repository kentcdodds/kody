import { expect, test } from 'vitest'
import { enrichOAuthTokenResponse } from '#worker/oidc/token-enrichment.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

function jsonResponse(body: Record<string, unknown>) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	})
}

function createOidcEnv(overrides: Record<string, unknown> = {}) {
	return {
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
		...overrides,
	} as unknown as Env
}

test('token enrichment mints id_token from helpers and skips when they are missing', async () => {
	const request = new Request('https://heykody.dev/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'grant_type=authorization_code',
	})
	const tokenBody = {
		access_token: 'opaque-access-token',
		token_type: 'bearer',
		scope: 'openid email profile',
	}
	const helpers = {
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
					nonce: 'nonce-123',
				},
			},
		}),
	}

	const enriched = await enrichOAuthTokenResponse(
		request,
		jsonResponse(tokenBody),
		createOidcEnv({ OAUTH_PROVIDER: helpers }),
	)
	expect(enriched.status).toBe(200)
	const payload = (await enriched.json()) as {
		access_token: string
		id_token?: string
	}
	expect(payload.access_token).toBe('opaque-access-token')
	expect(typeof payload.id_token).toBe('string')
	const claims = await verifyOidcJwtSignature(
		createOidcEnv(),
		payload.id_token ?? '',
	)
	expect(claims).toMatchObject({
		sub: 'user-stable-id',
		aud: 'client-123',
		email: 'user@example.com',
		nonce: 'nonce-123',
	})

	// Production `/oauth/token` never injects OAUTH_PROVIDER. Missing helpers
	// must not throw (that was KODY-6G / KODY-6Q) — return the token body.
	const skipped = await enrichOAuthTokenResponse(
		request,
		jsonResponse(tokenBody),
		createOidcEnv(),
	)
	expect(skipped.status).toBe(200)
	await expect(skipped.json()).resolves.toEqual(tokenBody)

	const withoutOpenid = await enrichOAuthTokenResponse(
		request,
		jsonResponse({ access_token: 'opaque-access-token', scope: 'profile' }),
		createOidcEnv({ OAUTH_PROVIDER: helpers }),
	)
	expect(withoutOpenid.status).toBe(200)
	await expect(withoutOpenid.json()).resolves.not.toHaveProperty('id_token')
})
