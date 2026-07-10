import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { openapiClientScaffoldCapability } from './openapi-client-scaffold.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const SPEC_URL = 'https://provider.example/openapi.json'

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
