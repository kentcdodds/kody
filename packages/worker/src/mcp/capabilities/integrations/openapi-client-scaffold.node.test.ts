import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { integrationsDomain } from './domain.ts'
import { openapiClientScaffoldCapability } from './openapi-client-scaffold.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const SPEC_URL = 'https://provider.example/openapi.json'

const fixtureSpec = {
	openapi: '3.0.3',
	info: {
		title: 'Scaffold Pets',
		version: '1.0.0',
	},
	servers: [{ url: 'https://api.pets.example/v1' }],
	paths: {
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
							schema: {
								type: 'object',
								properties: { name: { type: 'string' } },
							},
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
		},
	},
}

test('openapi_client_scaffold is registered on the integrations domain', () => {
	expect(
		integrationsDomain.capabilities.some(
			(capability) => capability.name === 'openapi_client_scaffold',
		),
	).toBe(true)
	expect(openapiClientScaffoldCapability.readOnly).toBe(true)
	expect(openapiClientScaffoldCapability.idempotent).toBe(true)
})

test('openapi_client_scaffold scaffolds a client from a JSON OpenAPI fixture', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])

	const result = await openapiClientScaffoldCapability.handler(
		{
			specUrl: SPEC_URL,
			// Slugs match parseOpenApiSpec(deriveOperationSlug): camelCase ids lowercased.
			operationIds: ['listpets', 'getpet', 'missing_op'],
			auth: { kind: 'bearerSecret', secretName: 'petsToken' },
			apiBaseUrl: 'https://api.pets.example/v1',
			providerLabel: 'Pets',
		},
		ctx,
	)

	expect(result.operations).toEqual([
		expect.objectContaining({
			slug: 'listpets',
			exportName: 'listpets',
			method: 'get',
			path: '/pets',
		}),
		expect.objectContaining({
			slug: 'getpet',
			exportName: 'getpet',
			method: 'get',
			path: '/pets/{petId}',
		}),
	])
	expect(result.warnings).toEqual(['Unknown operation slug: missing_op'])
	expect(result.moduleSource).toContain(
		'Scaffolded by Kody from an OpenAPI spec',
	)
	expect(result.moduleSource).toContain('Bearer {{secret:petsToken}}')
	expect(result.moduleSource).toContain('export async function listpets')
	expect(result.moduleSource).toContain('export async function getpet')
	expect(result.usageNotes).toMatch(/Paste moduleSource/)
	expect(result.usageNotes).toMatch(/host approval/)
	expect(result.usageNotes).toMatch(/bearerSecret/)
})

test('openapi_client_scaffold surfaces fetch failures without response body content', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () =>
			HttpResponse.json(
				{ secretLeak: 'should-not-appear-in-error' },
				{ status: 502 },
			),
		),
	])

	await expect(
		openapiClientScaffoldCapability.handler(
			{
				specUrl: SPEC_URL,
				operationIds: ['list_pets'],
				auth: { kind: 'none' },
				apiBaseUrl: 'https://api.pets.example/v1',
			},
			ctx,
		),
	).rejects.toThrow(/HTTP 502/)

	await expect(
		openapiClientScaffoldCapability.handler(
			{
				specUrl: SPEC_URL,
				operationIds: ['list_pets'],
				auth: { kind: 'none' },
				apiBaseUrl: 'https://api.pets.example/v1',
			},
			ctx,
		),
	).rejects.not.toThrow(/should-not-appear-in-error/)
})

test('openapi_client_scaffold rejects when no operation slugs resolve', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => HttpResponse.json(fixtureSpec)),
	])

	await expect(
		openapiClientScaffoldCapability.handler(
			{
				specUrl: SPEC_URL,
				operationIds: ['does_not_exist'],
				auth: { kind: 'none' },
				apiBaseUrl: 'https://api.pets.example/v1',
			},
			ctx,
		),
	).rejects.toThrow(/No resolvable operations/)
})
