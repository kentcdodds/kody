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
	const request = new Request(
		'https://heykody.dev/.well-known/openid-configuration',
	)
	const document = buildOpenIdConfiguration({
		env: createOidcEnv(),
		request,
	})
	expect(document.issuer).toBe('https://heykody.dev')
	expect(document.authorization_endpoint).toBe(
		'https://heykody.dev/oauth/authorize',
	)
	expect(document.token_endpoint).toBe('https://heykody.dev/oauth/token')
	expect(document.userinfo_endpoint).toBe('https://heykody.dev/oauth/userinfo')
	expect(document.jwks_uri).toBe('https://heykody.dev/.well-known/jwks.json')
	expect(document.end_session_endpoint).toBe('https://heykody.dev/oauth/logout')
	expect(document.response_types_supported).toEqual(['code'])
	expect(document.response_modes_supported).toEqual(['query'])
	expect(document.id_token_signing_alg_values_supported).toEqual(['RS256'])
	expect(document.scopes_supported).toEqual(['openid', 'profile', 'email'])
	expect(document.claims_supported).toContain('sub')
	expect(document.claims_supported).toContain('email')
	expect(document.token_endpoint_auth_methods_supported).toEqual([
		'none',
		'client_secret_basic',
		'client_secret_post',
	])
	expect(document.grant_types_supported).toEqual([
		'authorization_code',
		'refresh_token',
	])
})

test('jwks document exposes RS256 public key with configured kid', async () => {
	const env = createOidcEnv()
	const jwks = await getOidcJwksDocument(env)
	expect(jwks.keys).toHaveLength(1)
	expect(jwks.keys[0]).toMatchObject({
		kty: 'RSA',
		alg: 'RS256',
		use: 'sig',
		kid: TEST_OIDC_SIGNING_KEY_ID,
	})
	expect(jwks.keys[0]?.n).toBeTruthy()
	expect(jwks.keys[0]?.e).toBeTruthy()
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
