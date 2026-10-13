import { expect, test } from 'vitest'
import {
	assertEndpointsOnIssuerOrigin,
	McpOAuthFailedError,
	mcpOAuthFailedCode,
} from './oauth-issuer-endpoints.ts'

function discovery(overrides: Record<string, unknown> = {}) {
	return {
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			...overrides,
		},
	}
}

test('assertEndpointsOnIssuerOrigin accepts same-origin authorize and token endpoints', () => {
	expect(() => assertEndpointsOnIssuerOrigin(discovery())).not.toThrow()
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: undefined,
		}),
	).not.toThrow()
	expect(() => assertEndpointsOnIssuerOrigin({})).not.toThrow()
})

test('assertEndpointsOnIssuerOrigin refuses metadata that omits issuer', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin({
			authorizationServerMetadata: {
				authorization_endpoint: 'https://evil.example/authorize',
				token_endpoint: 'https://evil.example/token',
			},
		}),
	).toThrow(/missing a usable issuer/)
})

test('assertEndpointsOnIssuerOrigin refuses http issuer or token endpoints', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				issuer: 'http://auth.example',
				authorization_endpoint: 'http://auth.example/authorize',
				token_endpoint: 'http://auth.example/token',
			}),
		),
	).toThrow(/must use https/)
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({ token_endpoint: 'http://auth.example/token' }),
		),
	).toThrow(/token_endpoint .*different origin/)
})

for (const [field, endpoint] of [
	['authorization_endpoint', 'https://evil.example/authorize'],
	['token_endpoint', 'https://evil.example/token'],
] as const) {
	test(`assertEndpointsOnIssuerOrigin refuses a cross-origin ${field}`, () => {
		expect(() =>
			assertEndpointsOnIssuerOrigin(discovery({ [field]: endpoint })),
		).toThrow(McpOAuthFailedError)
		expect(() =>
			assertEndpointsOnIssuerOrigin(discovery({ [field]: endpoint })),
		).toThrow(
			new RegExp(`${mcpOAuthFailedCode}[\\s\\S]*${field} .*different origin`),
		)
	})
}

test('assertEndpointsOnIssuerOrigin refuses an unparseable endpoint URL', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({ authorization_endpoint: 'not a url' }),
		),
	).toThrow(/authorization_endpoint .*different origin/)
})

test('assertEndpointsOnIssuerOrigin skips registration_endpoint', () => {
	expect(() =>
		assertEndpointsOnIssuerOrigin(
			discovery({
				registration_endpoint: 'https://evil.example/register',
			}),
		),
	).not.toThrow()
})
