import { expect, test } from 'vitest'
import {
	stampAuthorizationResponseIssuer,
	withAuthorizationResponseIssuer,
} from './oauth-authorization-response.ts'

test('authorization redirects stamp RFC 9207 iss to the discovery issuer', () => {
	const issuer = 'https://kody.codes'
	const success = new URL(
		withAuthorizationResponseIssuer(
			'https://chatgpt.com/connector/oauth/vG3-MLZWUV83?code=abc&state=s',
			issuer,
		),
	)
	expect(success.origin + success.pathname).toBe(
		'https://chatgpt.com/connector/oauth/vG3-MLZWUV83',
	)
	expect(success.searchParams.get('code')).toBe('abc')
	expect(success.searchParams.get('state')).toBe('s')
	expect(success.searchParams.get('iss')).toBe(issuer)

	const denied = new URL(
		withAuthorizationResponseIssuer(
			'https://chatgpt.com/connector/oauth/vG3-MLZWUV83?error=access_denied&state=s',
			issuer,
		),
	)
	expect(denied.searchParams.get('error')).toBe('access_denied')
	expect(denied.searchParams.get('iss')).toBe(issuer)

	const drifted = new URL(
		withAuthorizationResponseIssuer(
			'https://chatgpt.com/callback?code=abc&iss=https%3A%2F%2Fwrong.example',
			issuer,
		),
	)
	expect(drifted.searchParams.get('iss')).toBe(issuer)
	expect(drifted.searchParams.get('code')).toBe('abc')

	const stamped = new URL(
		stampAuthorizationResponseIssuer(
			'https://codex.example/callback?code=demo',
			{
				env: {},
				requestUrl: 'https://kody.codes/oauth/authorize?client_id=codex',
			},
		),
	)
	expect(stamped.searchParams.get('code')).toBe('demo')
	expect(stamped.searchParams.get('iss')).toBe('https://kody.codes')
})
