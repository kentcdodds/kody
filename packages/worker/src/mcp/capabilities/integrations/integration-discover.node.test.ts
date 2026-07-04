import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	buildIntegrationDiscoverUrlForTest,
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

const linearDiscoverFixture = {
	version: 3,
	domain: 'linear.app',
	summary:
		'Linear exposes a GraphQL API at `https://api.linear.app/graphql`, a remote OAuth-protected MCP server at `https://mcp.linear.app/mcp`, and an official `linear` CLI.',
	description:
		'Linear is a product development and issue tracking platform for planning, building, and managing software work.',
	discoveredAt: '2026-07-04T13:38:37.470Z',
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

test('integration_discover returns parsed provider metadata with evidence links', async () => {
	const url = buildIntegrationDiscoverUrlForTest('linear.app')
	using _server = createMswNodeServer([
		http.get(url, () => HttpResponse.json(linearDiscoverFixture)),
	])

	const result = await integrationDiscoverCapability.handler(
		{ domain: 'linear.app' },
		ctx,
	)

	expect(result).toEqual({
		domain: 'linear.app',
		summary: linearDiscoverFixture.summary,
		description: linearDiscoverFixture.description,
		discoveredAt: linearDiscoverFixture.discoveredAt,
		source: url,
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
		],
	})
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

test('integration_discover surfaces 404 with integration_registry_search hint', async () => {
	const url = buildIntegrationDiscoverUrlForTest('missing.example')
	using _server = createMswNodeServer([
		http.get(url, () =>
			HttpResponse.json({ error: 'not found' }, { status: 404 }),
		),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'missing.example' }, ctx),
	).rejects.toThrow(
		/not in the integrations\.sh registry.*integration_registry_search/i,
	)
})

test('integration_discover rejects oversized response bodies', async () => {
	const url = buildIntegrationDiscoverUrlForTest('linear.app')
	const oversizedBody = JSON.stringify({
		...linearDiscoverFixture,
		padding: 'x'.repeat(500_001),
	})
	using _server = createMswNodeServer([
		http.get(url, () => new HttpResponse(oversizedBody)),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'linear.app' }, ctx),
	).rejects.toThrow(/response exceeds 500000 bytes/)
})

test('integration_discover rejects Content-Length above the cap before reading', async () => {
	const url = buildIntegrationDiscoverUrlForTest('linear.app')
	using _server = createMswNodeServer([
		http.get(
			url,
			() =>
				new HttpResponse(JSON.stringify(linearDiscoverFixture), {
					headers: { 'Content-Length': String(500_001) },
				}),
		),
	])

	await expect(
		integrationDiscoverCapability.handler({ domain: 'linear.app' }, ctx),
	).rejects.toThrow(/response exceeds 500000 bytes/)
})
