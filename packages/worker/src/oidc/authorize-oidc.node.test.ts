import { expect, test } from 'vitest'
import {
	getUnsupportedOidcResponseTypeError,
	parseOidcAuthorizeParams,
} from '#worker/oidc/authorize-oidc.ts'

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
