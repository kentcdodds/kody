import { expect, test } from 'vitest'
import { createListDetailRoute } from './list-detail-route.ts'

const mcpServersRoute = createListDetailRoute('/account/mcp-servers')
const nestedRoute = createListDetailRoute('/account/secrets', {
	parseDetailId(pathname) {
		const match = /^\/account\/secrets\/user\/([^/]+)$/.exec(pathname)
		return match?.[1] ? decodeURIComponent(match[1]) : null
	},
})

test('list-detail route helper supports the URL-backed list/detail workflow', () => {
	expect(mcpServersRoute.isRoutePath('/account/mcp-servers')).toBe(true)
	expect(mcpServersRoute.isRoutePath('/account/mcp-servers/new')).toBe(true)
	expect(mcpServersRoute.isRoutePath('/account/mcp-servers/server-1')).toBe(
		true,
	)
	expect(
		mcpServersRoute.isRoutePath('/account/mcp-servers/oauth/callback'),
	).toBe(true)
	expect(mcpServersRoute.isRoutePath('/account/secrets')).toBe(false)

	expect(mcpServersRoute.getSelection('/account/mcp-servers')).toEqual({
		selectedId: null,
		isCreating: false,
	})
	expect(mcpServersRoute.getSelection('/account/mcp-servers/new')).toEqual({
		selectedId: null,
		isCreating: true,
	})
	expect(
		mcpServersRoute.getSelection('/account/mcp-servers/server%201'),
	).toEqual({
		selectedId: 'server 1',
		isCreating: false,
	})
	expect(
		mcpServersRoute.getSelection('/account/mcp-servers/oauth/callback'),
	).toEqual({
		selectedId: null,
		isCreating: false,
	})
	expect(mcpServersRoute.getSelection('/account/mcp-servers/%')).toEqual({
		selectedId: '%',
		isCreating: false,
	})
	expect(mcpServersRoute.getSelection('/account/mcp-servers/%E0%A4%A')).toEqual(
		{
			selectedId: '%E0%A4%A',
			isCreating: false,
		},
	)

	expect(mcpServersRoute.buildListHref()).toBe('/account/mcp-servers')
	expect(mcpServersRoute.buildListHref('?q=docs')).toBe(
		'/account/mcp-servers?q=docs',
	)
	expect(mcpServersRoute.buildNewHref()).toBe('/account/mcp-servers/new')
	expect(mcpServersRoute.buildNewHref('?tab=oauth')).toBe(
		'/account/mcp-servers/new?tab=oauth',
	)
	expect(mcpServersRoute.buildDetailHref('server 1')).toBe(
		'/account/mcp-servers/server%201',
	)
	expect(mcpServersRoute.buildDetailHref('server 1', '?q=docs')).toBe(
		'/account/mcp-servers/server%201?q=docs',
	)

	expect(nestedRoute.getSelection('/account/secrets/new')).toEqual({
		selectedId: null,
		isCreating: true,
	})
	expect(nestedRoute.getSelection('/account/secrets/user/api%20key')).toEqual({
		selectedId: 'api key',
		isCreating: false,
	})
	expect(nestedRoute.getSelection('/account/secrets/approve')).toEqual({
		selectedId: null,
		isCreating: false,
	})
})
