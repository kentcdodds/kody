import { expect, test } from 'vitest'
import { buildOpenIdConfiguration } from '#worker/oidc/discovery.ts'
import {
	getOidcJwksDocument,
	resetOidcSigningKeyCacheForTests,
	verifyOidcJwtSignature,
} from '#worker/oidc/keys.ts'
import { mintIdToken } from '#worker/oidc/id-token.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

function createOidcEnv() {
	return {
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
	} as unknown as Env
}

test('openid-configuration advertises authorization code OIDC only', () => {
	const document = buildOpenIdConfiguration({
		env: createOidcEnv(),
		request: new Request(
			'https://heykody.dev/.well-known/openid-configuration',
		),
	})
	const authMethods = ['none', 'client_secret_basic', 'client_secret_post']
	expect(document).toMatchObject({
		issuer: 'https://heykody.dev',
		authorization_endpoint: 'https://heykody.dev/oauth/authorize',
		token_endpoint: 'https://heykody.dev/oauth/token',
		revocation_endpoint: 'https://heykody.dev/oauth/token',
		userinfo_endpoint: 'https://heykody.dev/oauth/userinfo',
		jwks_uri: 'https://heykody.dev/.well-known/jwks.json',
		end_session_endpoint: 'https://heykody.dev/oauth/logout',
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		id_token_signing_alg_values_supported: ['RS256'],
		scopes_supported: ['openid', 'profile', 'email'],
		token_endpoint_auth_methods_supported: authMethods,
		revocation_endpoint_auth_methods_supported: authMethods,
		grant_types_supported: ['authorization_code', 'refresh_token'],
	})
	expect(document.claims_supported).toEqual(
		expect.arrayContaining(['sub', 'email']),
	)
})

test('jwks document exposes RS256 public key with configured kid', async () => {
	const env = createOidcEnv()
	const jwks = await getOidcJwksDocument(env)
	expect(jwks.keys).toEqual([
		expect.objectContaining({
			kty: 'RSA',
			alg: 'RS256',
			use: 'sig',
			kid: TEST_OIDC_SIGNING_KEY_ID,
			n: expect.stringMatching(/./),
			e: expect.stringMatching(/./),
		}),
	])
})

test('jwks accepts PEM secrets stored with literal \\n escapes', async () => {
	resetOidcSigningKeyCacheForTests()
	const env = {
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM.replace(
			/\n/g,
			'\\n',
		),
	} as unknown as Env
	const jwks = await getOidcJwksDocument(env)
	expect(jwks.keys[0]?.kid).toBe(TEST_OIDC_SIGNING_KEY_ID)
	resetOidcSigningKeyCacheForTests()
})

test('minted id_token includes expected claims and verifies with JWKS key', async () => {
	const env = createOidcEnv()
	const request = new Request('https://heykody.dev/oauth/token')
	const idToken = await mintIdToken({
		env,
		request,
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
		includeNonce: true,
	})
	const payload = await verifyOidcJwtSignature(env, idToken)
	expect(payload).toMatchObject({
		iss: 'https://heykody.dev',
		sub: 'user-stable-id',
		aud: 'client-123',
		email: 'user@example.com',
		email_verified: true,
		preferred_username: 'test-user',
		auth_time: 1_700_000_000,
		nonce: 'nonce-123',
	})
	expect(typeof payload?.exp).toBe('number')
	expect(typeof payload?.iat).toBe('number')
})
