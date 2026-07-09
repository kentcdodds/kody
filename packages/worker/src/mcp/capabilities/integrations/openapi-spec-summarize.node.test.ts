import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { integrationsDomain } from './domain.ts'
import { openapiSpecSummarizeCapability } from './openapi-spec-summarize.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const JSON_SPEC_URL = 'https://provider.example/openapi.json'
const YAML_SPEC_URL = 'https://provider.example/openapi.yaml'

const petstoreLikeFixture = {
	openapi: '3.0.3',
	info: {
		title: 'Petstore Lite',
		version: '1.0.0',
		description: 'Tiny petstore-like OpenAPI fixture for summarization tests.',
	},
	servers: [
		{
			url: 'https://{env}.pets.example/v1',
			variables: {
				env: { default: 'api' },
			},
		},
	],
	components: {
		securitySchemes: {
			OAuth2: {
				type: 'oauth2',
				flows: {
					authorizationCode: {
						authorizationUrl: 'https://auth.pets.example/authorize',
						tokenUrl: 'https://auth.pets.example/token',
						scopes: {
							'pets:read': 'Read pets',
							'pets:write': 'Write pets',
						},
					},
				},
			},
			ApiKey: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Api-Key',
			},
		},
		schemas: {
			Pet: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					name: { type: 'string' },
				},
			},
		},
	},
	security: [{ OAuth2: ['pets:read'] }],
	paths: {
		'/me': {
			get: {
				operationId: 'getMe',
				summary: 'Current user',
				tags: ['account'],
				responses: { '200': { description: 'ok' } },
			},
		},
		'/pets': {
			get: {
				operationId: 'listPets',
				summary: 'List pets',
				tags: ['pets'],
				responses: { '200': { description: 'ok' } },
			},
			post: {
				operationId: 'createPet',
				summary: 'Create pet',
				tags: ['pets'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/Pet' },
						},
					},
				},
				responses: { '201': { description: 'created' } },
			},
		},
		'/pets/{petId}': {
			get: {
				operationId: 'getPet',
				summary: 'Get pet',
				tags: ['pets'],
				parameters: [
					{
						name: 'petId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				responses: { '200': { description: 'ok' } },
			},
			delete: {
				operationId: 'deletePet',
				summary: 'Delete pet',
				tags: ['pets'],
				parameters: [
					{
						name: 'petId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				responses: { '204': { description: 'deleted' } },
			},
		},
		'/stores': {
			get: {
				operationId: 'listStores',
				summary: 'List stores',
				tags: ['stores'],
				responses: { '200': { description: 'ok' } },
			},
		},
	},
}

const yamlFixture = `
openapi: 3.1.0
info:
  title: YAML Pets
  version: "2.0.0"
servers:
  - url: https://yaml.pets.example
paths:
  /health:
    get:
      operationId: health
      responses:
        "200":
          description: ok
`

test('openapi_spec_summarize is registered on the integrations domain', () => {
	expect(
		integrationsDomain.capabilities.some(
			(capability) => capability.name === 'openapi_spec_summarize',
		),
	).toBe(true)
	expect(openapiSpecSummarizeCapability.readOnly).toBe(true)
	expect(openapiSpecSummarizeCapability.idempotent).toBe(true)
})

test('openapi_spec_summarize summarizes a JSON OpenAPI fixture end-to-end', async () => {
	using _server = createMswNodeServer([
		http.get(JSON_SPEC_URL, () => HttpResponse.json(petstoreLikeFixture)),
	])

	const result = await openapiSpecSummarizeCapability.handler(
		{
			specUrl: JSON_SPEC_URL,
			operationFilter: { tags: ['pets'] },
			maxOperations: 10,
		},
		ctx,
	)

	expect(result.specUrl).toBe(JSON_SPEC_URL)
	expect(result.title).toBe('Petstore Lite')
	expect(result.openapiVersion).toBe('3.0.3')
	expect(result.suggestedApiBaseUrl).toBe('https://api.pets.example/v1')
	expect(result.suggestedHosts).toEqual(['api.pets.example'])
	expect(result.defaultSecuritySchemeNames).toEqual(['OAuth2'])
	expect(result.auth.map((entry) => entry.schemeName).sort()).toEqual([
		'ApiKey',
		'OAuth2',
	])
	expect(
		result.auth.find((entry) => entry.schemeName === 'OAuth2')?.kodyAuthPath,
	).toMatch(/integration_save/)
	expect(result.suggestedSmokeTestOperations[0]?.path).toBe('/me')
	expect(
		result.operations.every((operation) => operation.tags.includes('pets')),
	).toBe(true)
	expect(result.operationCount).toBe(4)
	expect(result.truncated).toBe(false)
})

test('openapi_spec_summarize summarizes a YAML OpenAPI fixture end-to-end', async () => {
	using _server = createMswNodeServer([
		http.get(YAML_SPEC_URL, () => new HttpResponse(yamlFixture)),
	])

	const result = await openapiSpecSummarizeCapability.handler(
		{ specUrl: YAML_SPEC_URL },
		ctx,
	)

	expect(result.title).toBe('YAML Pets')
	expect(result.openapiVersion).toBe('3.1.0')
	expect(result.suggestedApiBaseUrl).toBe('https://yaml.pets.example/')
	expect(result.operations).toEqual([
		expect.objectContaining({
			slug: 'health',
			method: 'get',
			path: '/health',
		}),
	])
})

test('openapi_spec_summarize surfaces fetch failures without response body content', async () => {
	using _server = createMswNodeServer([
		http.get(JSON_SPEC_URL, () =>
			HttpResponse.json(
				{ secretLeak: 'should-not-appear-in-error' },
				{ status: 502 },
			),
		),
	])

	await expect(
		openapiSpecSummarizeCapability.handler({ specUrl: JSON_SPEC_URL }, ctx),
	).rejects.toThrow(/HTTP 502/)

	await expect(
		openapiSpecSummarizeCapability.handler({ specUrl: JSON_SPEC_URL }, ctx),
	).rejects.not.toThrow(/should-not-appear-in-error/)
})
