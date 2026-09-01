import { expect, test } from 'vitest'
import {
	evaluateOidcAuthorizeGate,
	getUnsupportedOidcResponseTypeError,
	isOidcAuthorizeParamsParseError,
	parseOidcAuthorizeParams,
} from '#worker/oidc/authorize-oidc.ts'
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

test('authorize-oidc rejects implicit and hybrid response types', () => {
	expect(getUnsupportedOidcResponseTypeError('code')).toBeNull()
	expect(getUnsupportedOidcResponseTypeError('id_token')).toMatch(
		/authorization code/i,
	)
	expect(getUnsupportedOidcResponseTypeError('code id_token token')).toMatch(
		/authorization code/i,
	)
	expect(getUnsupportedOidcResponseTypeError('token')).toMatch(
		/authorization code/i,
	)
})

test('authorize-oidc parses nonce prompt max_age and id_token_hint', () => {
	const request = new Request(
		'https://heykody.dev/oauth/authorize?response_type=code&nonce=demo-nonce&prompt=login&max_age=300&id_token_hint=eyJ.test',
	)
	expect(parseOidcAuthorizeParams(request)).toEqual({
		nonce: 'demo-nonce',
		prompt: 'login',
		maxAge: 300,
		idTokenHint: 'eyJ.test',
		responseType: 'code',
	})
})

test('authorize-oidc rejects malformed max_age', () => {
	const request = new Request(
		'https://heykody.dev/oauth/authorize?response_type=code&max_age=300abc',
	)
	const parsed = parseOidcAuthorizeParams(request)
	expect(isOidcAuthorizeParamsParseError(parsed)).toBe(true)
	if (isOidcAuthorizeParamsParseError(parsed)) {
		expect(parsed.errorCode).toBe('invalid_request')
	}
})

test('authorize-oidc rejects empty max_age', () => {
	const request = new Request(
		'https://heykody.dev/oauth/authorize?response_type=code&max_age=',
	)
	const parsed = parseOidcAuthorizeParams(request)
	expect(isOidcAuthorizeParamsParseError(parsed)).toBe(true)
	if (isOidcAuthorizeParamsParseError(parsed)) {
		expect(parsed.errorCode).toBe('invalid_request')
	}
})

test('authorize-oidc rejects prompt=none combined with login or consent', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: {
			prompt: 'none consent',
			responseType: 'code',
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request('https://heykody.dev/oauth/authorize'),
		env: createOidcEnv(),
	})
	expect(result.ok).toBe(false)
	if (!result.ok) {
		expect(result.errorCode).toBe('invalid_request')
	}
})

test('authorize-oidc max_age fails closed without sessionIssuedAt', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: {
			maxAge: 60,
			responseType: 'code',
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: undefined,
		},
		request: new Request('https://heykody.dev/oauth/authorize'),
		env: createOidcEnv(),
	})
	expect(result.ok).toBe(true)
	if (result.ok) {
		expect(result.treatAsSignedOut).toBe(true)
	}
})

test('authorize-oidc prompt=login requires credentials without clearing cookie intent', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: {
			prompt: 'login',
			responseType: 'code',
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request('https://heykody.dev/oauth/authorize'),
		env: createOidcEnv(),
	})
	expect(result.ok).toBe(true)
	if (result.ok) {
		expect(result.treatAsSignedOut).toBe(true)
		expect(result.silentAuthorize).toBeUndefined()
	}
})

test('authorize-oidc prompt=consent sets requireConsent', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: {
			prompt: 'consent',
			responseType: 'code',
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request('https://heykody.dev/oauth/authorize'),
		env: createOidcEnv(),
	})
	expect(result.ok).toBe(true)
	if (result.ok) {
		expect(result.requireConsent).toBe(true)
		expect(result.treatAsSignedOut).toBe(false)
	}
})

test('authorize-oidc prompt=none with session enables silent authorize', async () => {
	const result = await evaluateOidcAuthorizeGate({
		params: {
			prompt: 'none',
			responseType: 'code',
		},
		session: {
			sessionEmail: 'user@example.com',
			sessionStableUserId: 'user-1',
			sessionIssuedAt: Date.now(),
		},
		request: new Request('https://heykody.dev/oauth/authorize'),
		env: createOidcEnv(),
	})
	expect(result.ok).toBe(true)
	if (result.ok) {
		expect(result.silentAuthorize).toBe(true)
		expect(result.forbidInlineLogin).toBe(true)
	}
})
