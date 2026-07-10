import { expect, test } from 'vitest'
import { parseOpenApiSpec } from './parse-spec.ts'
import { summarizeOpenApiSpec } from './summarize-spec.ts'
import {
	type OpenApiOperation,
	type OpenApiSecurityScheme,
	type ParsedOpenApiSpec,
} from './spec-types.ts'

function baseSpec(
	overrides: Partial<ParsedOpenApiSpec> = {},
): ParsedOpenApiSpec {
	return {
		openapiVersion: '3.0.3',
		title: 'Demo',
		version: '1.0.0',
		description: null,
		servers: [
			{ url: 'https://api.demo.example/v1', description: 'prod' },
			{ url: 'https://staging.demo.example/v1', description: 'staging' },
			{ url: '/relative', description: 'relative' },
		],
		operations: [],
		securitySchemes: [],
		defaultSecuritySchemeNames: [],
		warnings: [],
		...overrides,
	}
}

function op(
	partial: Partial<OpenApiOperation> &
		Pick<OpenApiOperation, 'method' | 'path' | 'slug'>,
): OpenApiOperation {
	return {
		operationId: null,
		summary: null,
		description: null,
		tags: [],
		deprecated: false,
		parameters: [],
		requestBody: null,
		securitySchemeNames: [],
		...partial,
	}
}

test('summarizeOpenApiSpec maps auth schemes to structured auth entries', () => {
	const schemes: Array<OpenApiSecurityScheme> = [
		{
			name: 'OAuthAuthCode',
			type: 'oauth2',
			description: null,
			in: null,
			parameterName: null,
			scheme: null,
			flows: ['authorizationCode'],
			authorizationUrl: 'https://auth.demo.example/authorize',
			tokenUrl: 'https://auth.demo.example/token',
			scopes: ['read'],
		},
		{
			name: 'OAuthClientCreds',
			type: 'oauth2',
			description: null,
			in: null,
			parameterName: null,
			scheme: null,
			flows: ['clientCredentials'],
			authorizationUrl: null,
			tokenUrl: 'https://auth.demo.example/token',
			scopes: [],
		},
		{
			name: 'Bearer',
			type: 'http',
			description: null,
			in: null,
			parameterName: null,
			scheme: 'bearer',
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
		{
			name: 'Basic',
			type: 'http',
			description: null,
			in: null,
			parameterName: null,
			scheme: 'basic',
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
		{
			name: 'HeaderKey',
			type: 'apiKey',
			description: null,
			in: 'header',
			parameterName: 'X-Api-Key',
			scheme: null,
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
		{
			name: 'QueryKey',
			type: 'apiKey',
			description: null,
			in: 'query',
			parameterName: 'api_key',
			scheme: null,
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
		{
			name: 'Mtls',
			type: 'mutualTLS',
			description: null,
			in: null,
			parameterName: null,
			scheme: null,
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
		{
			name: 'Weird',
			type: 'unknown',
			description: null,
			in: null,
			parameterName: null,
			scheme: null,
			flows: [],
			authorizationUrl: null,
			tokenUrl: null,
			scopes: [],
		},
	]

	const auth = summarizeOpenApiSpec(baseSpec({ securitySchemes: schemes })).auth
	expect(auth).toHaveLength(schemes.length)

	const byName = Object.fromEntries(
		auth.map((entry) => [entry.schemeName, entry]),
	)
	expect(byName.OAuthAuthCode?.detail).toBe('oauth2 authorizationCode')
	expect(byName.OAuthClientCreds?.detail).toBe('oauth2 clientCredentials')
	expect(byName.Bearer?.detail).toBe('http bearer')
	expect(byName.Basic?.detail).toBe('http basic')
	expect(byName.HeaderKey?.detail).toBe('apiKey in header X-Api-Key')
	expect(byName.QueryKey?.detail).toBe('apiKey in query api_key')
	expect(byName.Mtls?.detail).toBe('mutualTLS')
	expect(byName.Weird?.detail).toBe('unknown')
	for (const entry of auth) {
		expect(entry.kodyAuthPath.length).toBeGreaterThan(0)
	}
})

test('summarizeOpenApiSpec prefers identity GET smoke tests then shortest paths', () => {
	const summary = summarizeOpenApiSpec(
		baseSpec({
			operations: [
				op({
					method: 'get',
					path: '/widgets',
					slug: 'list_widgets',
					summary: 'list',
				}),
				op({
					method: 'get',
					path: '/account',
					slug: 'get_account',
					summary: 'account',
				}),
				op({
					method: 'get',
					path: '/me',
					slug: 'get_me',
					summary: 'me',
				}),
				op({
					method: 'get',
					path: '/users/me',
					slug: 'get_users_me',
					summary: 'users me',
				}),
				op({
					method: 'post',
					path: '/me',
					slug: 'post_me',
					summary: 'not get',
				}),
				op({
					method: 'get',
					path: '/me/settings',
					slug: 'get_me_settings',
					summary: 'settings',
					parameters: [
						{
							name: 'expand',
							location: 'query',
							required: true,
							description: null,
							schema: null,
						},
					],
				}),
				op({
					method: 'get',
					path: '/deprecated',
					slug: 'get_deprecated',
					deprecated: true,
				}),
			],
		}),
	)

	expect(
		summary.suggestedSmokeTestOperations.map((entry) => entry.path),
	).toEqual(['/me', '/users/me', '/account'])
	expect(summary.suggestedSmokeTestOperations[0]?.method).toBe('get')
})

test('summarizeOpenApiSpec filters and truncates operations', () => {
	const summary = summarizeOpenApiSpec(
		baseSpec({
			operations: [
				op({
					method: 'get',
					path: '/pets',
					slug: 'list_pets',
					tags: ['pets'],
					summary: 'List pets',
					operationId: 'listPets',
				}),
				op({
					method: 'get',
					path: '/pets/{id}',
					slug: 'get_pet',
					tags: ['pets'],
					summary: 'Get pet',
				}),
				op({
					method: 'get',
					path: '/stores',
					slug: 'list_stores',
					tags: ['stores'],
					summary: 'List stores',
				}),
			],
		}),
		{
			maxOperations: 1,
			operationFilter: {
				tags: ['PETS'],
				pathPrefixes: ['/pets'],
				search: 'pet',
			},
		},
	)

	expect(summary.operationCount).toBe(2)
	expect(summary.truncated).toBe(true)
	expect(summary.operations).toHaveLength(1)
	expect(summary.operations[0]?.slug).toBe('list_pets')
})

test('summarizeOpenApiSpec works on a parsed multi-scheme fixture', () => {
	const parsed = parseOpenApiSpec(
		JSON.stringify({
			openapi: '3.0.3',
			info: { title: 'Pets', version: '1' },
			servers: [{ url: 'https://pets.example/api' }],
			components: {
				securitySchemes: {
					oauth: {
						type: 'oauth2',
						flows: {
							authorizationCode: {
								authorizationUrl: 'https://pets.example/oauth/authorize',
								tokenUrl: 'https://pets.example/oauth/token',
								scopes: { read: 'read' },
							},
						},
					},
					apiKey: {
						type: 'apiKey',
						in: 'header',
						name: 'X-Api-Key',
					},
				},
			},
			security: [{ oauth: ['read'] }],
			paths: {
				'/me': {
					get: {
						operationId: 'getMe',
						responses: { '200': { description: 'ok' } },
					},
				},
				'/pets': {
					get: {
						tags: ['pets'],
						responses: { '200': { description: 'ok' } },
					},
				},
			},
		}),
	)
	const summary = summarizeOpenApiSpec(parsed)
	expect(summary.suggestedApiBaseUrl).toBe('https://pets.example/api')
	expect(summary.defaultSecuritySchemeNames).toEqual(['oauth'])
	expect(summary.auth.map((entry) => entry.schemeName).sort()).toEqual([
		'apiKey',
		'oauth',
	])
	expect(summary.suggestedSmokeTestOperations[0]?.path).toBe('/me')
})
