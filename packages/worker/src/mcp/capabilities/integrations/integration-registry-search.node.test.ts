import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
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

test('integration_registry_search returns parsed results and rejects upstream failures', async () => {
	// msw warns about the query string in the handler URL; that tooling
	// notice is incidental to the capability behavior under test.
	consoleWarn.mockImplementation(() => {})
	const url = buildIntegrationRegistrySearchUrlForTest('linear')
	using _successServer = createMswNodeServer([
		http.get(url, () => HttpResponse.json(searchFixture)),
	])

	const result = await integrationRegistrySearchCapability.handler(
		{ query: 'linear', limit: 2 },
		ctx,
	)
	expect(result).toEqual({
		results: searchFixture.results.slice(0, 2),
	})

	using _errorServer = createMswNodeServer([
		http.get(url, () =>
			HttpResponse.json({ error: 'upstream' }, { status: 502 }),
		),
	])
	await expect(
		integrationRegistrySearchCapability.handler({ query: 'linear' }, ctx),
	).rejects.toThrow(/integrations\.sh registry search failed: HTTP 502/)

	using _oversizedServer = createMswNodeServer([
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
