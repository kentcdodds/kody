import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	buildIntegrationDiscoverUrlForTest,
	buildIntegrationSurfaceUrlForTest,
	integrationDiscoverCapability,
	normalizeProviderDomain,
} from './integration-discover.ts'

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

const freshDiscoveredAt = new Date(Date.now() - 60_000).toISOString()
const staleDiscoveredAt = new Date(
	Date.now() - 90 * 24 * 60 * 60 * 1000,
).toISOString()

const linearRegistryFixture = {
	version: 3,
	domain: 'linear.app',
	summary:
		'Linear exposes a GraphQL API at `https://api.linear.app/graphql`, a remote OAuth-protected MCP server at `https://mcp.linear.app/mcp`, and an official `linear` CLI.',
	description:
		'Linear is a product development and issue tracking platform for planning, building, and managing software work.',
	discoveredAt: freshDiscoveredAt,
	credentials: {
		linear_personal_api_key: {
			type: 'api_key',
			label: 'Linear personal API key',
			generateUrl: 'https://linear.app/settings/account/security',
			setup:
				'In Linear, go to Settings → Account → Security & Access and create a personal API key.',
			acquisition: 'manual',
		},
		linear_oauth_app: {
			type: 'oauth2',
			label: 'OAuth 2.0',
			generateUrl: null,
			setup:
				'Point your MCP client at the server URL and approve access in the browser.',
		},
	},
	surfaces: [
		{
			type: 'graphql',
			url: 'https://api.linear.app/graphql',
			spec: 'https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql',
			name: 'Linear GraphQL API',
			docs: 'https://linear.app/developers/graphql',
			basis: {
				via: 'discovered',
				evidence: [
					'https://linear.app/llms.txt',
					'https://linear.app/developers/oauth-2-0-authentication',
				],
			},
		},
		{
			type: 'mcp',
			url: 'https://mcp.linear.app/mcp',
			spec: null,
			name: 'Linear MCP server',
			docs: 'https://linear.app/docs/mcp',
			basis: {
				via: 'detected',
				signal: 'mcp:initialize',
			},
		},
	],
	usedLlm: true,
}

const expectedLinearCredentials = {
	linear_personal_api_key: {
		type: 'api_key',
		label: 'Linear personal API key',
		generateUrl: 'https://linear.app/settings/account/security',
		setup:
			'In Linear, go to Settings → Account → Security & Access and create a personal API key.',
		acquisition: 'manual',
	},
	linear_oauth_app: {
		type: 'oauth2',
		label: 'OAuth 2.0',
		setup:
			'Point your MCP client at the server URL and approve access in the browser.',
	},
}

const expectedLinearSurfaces = [
	{
		type: 'graphql',
		url: 'https://api.linear.app/graphql',
		spec: 'https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql',
		name: 'Linear GraphQL API',
		docs: 'https://linear.app/developers/graphql',
		evidence: [
			'https://linear.app/llms.txt',
			'https://linear.app/developers/oauth-2-0-authentication',
		],
	},
	{
		type: 'mcp',
		url: 'https://mcp.linear.app/mcp',
		name: 'Linear MCP server',
		docs: 'https://linear.app/docs/mcp',
	},
]

test('integration_discover serves fresh cached surface data without calling live discovery', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('linear.app')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('linear.app')
	let liveDiscoverCalls = 0
	using _server = createMswNodeServer([
		http.get(surfaceUrl, () => HttpResponse.json(linearRegistryFixture)),
		http.get(discoverUrl, () => {
			liveDiscoverCalls += 1
			return HttpResponse.json(linearRegistryFixture)
		}),
	])

	const result = await integrationDiscoverCapability.handler(
		{ domain: 'linear.app' },
		ctx,
	)

	expect(liveDiscoverCalls).toBe(0)
	expect(result).toEqual({
		domain: 'linear.app',
		summary: linearRegistryFixture.summary,
		description: linearRegistryFixture.description,
		discoveredAt: freshDiscoveredAt,
		source: surfaceUrl,
		provenance: 'cached',
		liveDiscoveryError: null,
		credentials: expectedLinearCredentials,
		surfaces: expectedLinearSurfaces,
	})
})

test('integration_discover runs live discovery when cached surface is missing or empty', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('linear.app')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('linear.app')

	for (const surfaceResponse of [
		() => HttpResponse.json({ error: 'not found' }, { status: 404 }),
		() =>
			HttpResponse.json({
				version: 3,
				domain: 'linear.app',
				discoveredAt: freshDiscoveredAt,
				credentials: {},
				surfaces: [],
			}),
	]) {
		using _server = createMswNodeServer([
			http.get(surfaceUrl, surfaceResponse),
			http.get(discoverUrl, () => HttpResponse.json(linearRegistryFixture)),
		])

		const result = await integrationDiscoverCapability.handler(
			{ domain: 'linear.app' },
			ctx,
		)
		expect(result).toMatchObject({
			domain: 'linear.app',
			source: discoverUrl,
			provenance: 'live',
			liveDiscoveryError: null,
			surfaces: expectedLinearSurfaces,
		})
	}
})

test('integration_discover attempts live rediscovery for stale cached data and returns the live result', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('linear.app')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('linear.app')
	const liveFixture = {
		...linearRegistryFixture,
		discoveredAt: freshDiscoveredAt,
	}
	using _server = createMswNodeServer([
		http.get(surfaceUrl, () =>
			HttpResponse.json({
				...linearRegistryFixture,
				discoveredAt: staleDiscoveredAt,
			}),
		),
		http.get(discoverUrl, () => HttpResponse.json(liveFixture)),
	])

	const result = await integrationDiscoverCapability.handler(
		{ domain: 'linear.app' },
		ctx,
	)

	expect(result).toMatchObject({
		discoveredAt: freshDiscoveredAt,
		source: discoverUrl,
		provenance: 'live',
		liveDiscoveryError: null,
	})
})

test('integration_discover falls back to stale cached data when live discovery fails', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('slack.com')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('slack.com')
	const staleFixture = {
		...linearRegistryFixture,
		domain: 'slack.com',
		discoveredAt: staleDiscoveredAt,
	}
	const failingBody = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"domain":'))
			controller.error(new Error('body stream aborted'))
		},
	})

	for (const discoverResponse of [
		() => HttpResponse.error(),
		() => new HttpResponse(failingBody),
	]) {
		using _server = createMswNodeServer([
			http.get(surfaceUrl, () => HttpResponse.json(staleFixture)),
			http.get(discoverUrl, discoverResponse),
		])

		const result = await integrationDiscoverCapability.handler(
			{ domain: 'slack.com' },
			ctx,
		)
		expect(result).toMatchObject({
			domain: 'slack.com',
			discoveredAt: staleDiscoveredAt,
			source: surfaceUrl,
			provenance: 'cached',
			surfaces: expectedLinearSurfaces,
		})
		expect(result.liveDiscoveryError).toMatch(/live discovery failed/)
	}
})

test('integration_discover fails with a clear terminal error when neither cached nor live data is usable', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('linear.app')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('linear.app')
	using _server = createMswNodeServer([
		http.get(surfaceUrl, () =>
			HttpResponse.json({ error: 'not found' }, { status: 404 }),
		),
		http.get(discoverUrl, () => HttpResponse.error()),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'linear.app' }, ctx),
	).rejects.toThrow(
		/integrations\.sh discover failed: .*No usable cached surface data/,
	)
})

test('integration_discover reports a registry miss when both endpoints return 404', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('missing.example')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('missing.example')
	using _server = createMswNodeServer([
		http.get(surfaceUrl, () =>
			HttpResponse.json({ error: 'not found' }, { status: 404 }),
		),
		http.get(discoverUrl, () =>
			HttpResponse.json({ error: 'not found' }, { status: 404 }),
		),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'missing.example' }, ctx),
	).rejects.toThrow(
		/not in the integrations\.sh registry.*integration_registry_search/i,
	)
})

test('integration_discover rejects invalid domain input before fetching', async () => {
	await expect(
		integrationDiscoverCapability.handler(
			{ domain: 'https://evil.com/x' },
			ctx,
		),
	).rejects.toThrow(
		/must not include a URL scheme|must be a bare hostname without a path/,
	)

	expect(normalizeProviderDomain(' Linear.APP ')).toBe('linear.app')
})

test('integration_discover rejects oversized response bodies from both endpoints', async () => {
	const surfaceUrl = buildIntegrationSurfaceUrlForTest('linear.app')
	const discoverUrl = buildIntegrationDiscoverUrlForTest('linear.app')
	const oversizedBody = JSON.stringify({
		...linearRegistryFixture,
		padding: 'x'.repeat(500_001),
	})
	using _oversizedServer = createMswNodeServer([
		http.get(surfaceUrl, () => new HttpResponse(oversizedBody)),
		http.get(discoverUrl, () => new HttpResponse(oversizedBody)),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'linear.app' }, ctx),
	).rejects.toThrow(/response exceeds 500000 bytes/)

	using _contentLengthServer = createMswNodeServer([
		http.get(
			surfaceUrl,
			() =>
				new HttpResponse(JSON.stringify(linearRegistryFixture), {
					headers: { 'Content-Length': String(500_001) },
				}),
		),
		http.get(
			discoverUrl,
			() =>
				new HttpResponse(JSON.stringify(linearRegistryFixture), {
					headers: { 'Content-Length': String(500_001) },
				}),
		),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'linear.app' }, ctx),
	).rejects.toThrow(/response exceeds 500000 bytes/)
})
