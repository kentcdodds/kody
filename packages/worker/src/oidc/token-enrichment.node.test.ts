import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { enrichOAuthTokenResponse } from '#worker/oidc/token-enrichment.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'
import { handleOidcUserinfoRequest } from '#worker/oidc/userinfo.ts'
import { evaluateOidcAuthorizeGate } from '#worker/oidc/authorize-oidc.ts'
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
					userId: ownerIdFromStored('user-stable-id'),
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

test('org connections have distinct subjects that agree across token exchange, refresh, and userinfo', async () => {
	const subjects = []
	for (const [userId, orgId] of [
		['user-stable-id', undefined],
		['user-stable-id', 'user-stable-id'],
		['user-stable-id', 'tanstack-org'],
		['user-stable-id', 'another-org'],
		['another-user', 'tanstack-org'],
	] as const) {
		const scope = ['openid', 'email', 'profile']
		const env = createOidcEnv({
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
				async unwrapToken() {
					return {
						scope,
						grant: {
							clientId: 'client-123',
							scope,
							props: {
								userId,
								orgId,
								email: 'user@example.com',
								username: 'test-user',
								displayName: 'test-user',
								authTime: 1_700_000_000,
								nonce: 'nonce-123',
							},
						},
					}
				},
			},
		})
		const userinfo = await handleOidcUserinfoRequest(
			new Request('https://heykody.dev/oauth/userinfo', {
				headers: { Authorization: 'Bearer access-token' },
			}),
			env,
		)
		expect(userinfo.status).toBe(200)
		const identity = (await userinfo.json()) as { sub: string }
		subjects.push(identity.sub)
		for (const grantType of ['authorization_code', 'refresh_token']) {
			const response = await enrichOAuthTokenResponse(
				new Request('https://heykody.dev/oauth/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ grant_type: grantType }),
				}),
				jsonResponse({ access_token: 'access-token', scope: scope.join(' ') }),
				env,
			)
			const body = (await response.json()) as { id_token: string }
			const claims = await verifyOidcJwtSignature(env, body.id_token)
			expect(claims?.sub).toBe(identity.sub)
			expect(claims?.nonce).toBe(
				grantType === 'authorization_code' ? 'nonce-123' : undefined,
			)
			for (const sessionUserId of [userId, 'unrelated-user']) {
				const gate = await evaluateOidcAuthorizeGate({
					params: {
						responseType: 'code',
						prompt: 'none',
						idTokenHint: body.id_token,
					},
					session: {
						sessionEmail: 'user@example.com',
						sessionStableUserId: sessionUserId,
						sessionIssuedAt: Date.now(),
					},
					request: new Request('https://heykody.dev/oauth/authorize'),
					env,
				})
				expect(gate.ok).toBe(sessionUserId === userId)
			}
		}
	}
	expect(subjects[0]).toBe('user-stable-id')
	expect(subjects[1]).toBe(subjects[0])
	expect(new Set(subjects.slice(1)).size).toBe(4)
})
