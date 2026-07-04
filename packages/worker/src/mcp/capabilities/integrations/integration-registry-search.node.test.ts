import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	buildIntegrationRegistrySearchUrlForTest,
	integrationRegistrySearchCapability,
} from './integration-registry-search.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const searchFixture = {
	results: [
		{
			domain: 'linear.app',
			name: 'linear.app',
			description: 'Manage issues, projects, and team workflows in Linear.',
			kinds: ['mcp', 'cli'],
			url: 'https://integrations.sh/linear.app/',
		},
		{
			domain: 'linearb.io',
			name: 'linearb.io',
			description: 'Engineering analytics platform.',
			kinds: ['api'],
			url: 'https://integrations.sh/linearb.io/',
		},
		{
			domain: 'linearity.io',
			name: 'linearity.io',
			description: 'Vector design tools.',
			kinds: ['api', 'mcp'],
			url: 'https://integrations.sh/linearity.io/',
		},
	],
}

test('integration_registry_search returns parsed results and respects limit', async () => {
	const url = buildIntegrationRegistrySearchUrlForTest('linear')
	using _server = createMswNodeServer([
		http.get(url, () => HttpResponse.json(searchFixture)),
	])

	const result = await integrationRegistrySearchCapability.handler(
		{ query: 'linear', limit: 2 },
		ctx,
	)

	expect(result).toEqual({
		results: searchFixture.results.slice(0, 2),
	})
})

test('integration_registry_search surfaces non-OK HTTP failures', async () => {
	const url = buildIntegrationRegistrySearchUrlForTest('linear')
	using _server = createMswNodeServer([
		http.get(url, () =>
			HttpResponse.json({ error: 'upstream' }, { status: 502 }),
		),
	])

	await expect(
		integrationRegistrySearchCapability.handler({ query: 'linear' }, ctx),
	).rejects.toThrow(/integrations\.sh registry search failed: HTTP 502/)
})

test('integration_registry_search rejects Content-Length above the cap before reading', async () => {
	const url = buildIntegrationRegistrySearchUrlForTest('linear')
	using _server = createMswNodeServer([
		http.get(
			url,
			() =>
				new HttpResponse('{"results":[]}', {
					headers: { 'Content-Length': String(500_001) },
				}),
		),
	])

	await expect(
		integrationRegistrySearchCapability.handler({ query: 'linear' }, ctx),
	).rejects.toThrow(/response exceeds 500000 bytes/)
})
