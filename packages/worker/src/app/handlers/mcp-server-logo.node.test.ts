import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getMcpServerSettingById: vi.fn(),
	loadFittedMcpServerLogo: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	getMcpServerSettingById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingById(...args),
}))

vi.mock('#worker/mcp-client/mcp-server-logo.ts', () => ({
	loadFittedMcpServerLogo: (...args: Array<unknown>) =>
		mockModule.loadFittedMcpServerLogo(...args),
}))

const { createMcpServerLogoHandler } = await import('./mcp-server-logo.ts')

test('MCP server logo route is owner-scoped and private', async () => {
	const handler = createMcpServerLogoHandler({} as Env)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const anonymous = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(anonymous.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		mcpUser: { userId: 'user-1' },
	})
	mockModule.getMcpServerSettingById.mockResolvedValueOnce(null)
	const missing = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(missing.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		mcpUser: { userId: 'user-1' },
	})
	mockModule.getMcpServerSettingById.mockResolvedValueOnce({
		id: 's1',
		logoKey: 'user-mcp-server-logos/user-1/s1/abc.webp',
		logoContentType: 'image/webp',
		logoSource: 'favicon',
		faviconSourceHost: 'example.com',
	})
	mockModule.loadFittedMcpServerLogo.mockResolvedValueOnce({
		body: new Blob([Uint8Array.from([1, 2, 3])]).stream(),
		size: 3,
		httpEtag: '"abc"',
		contentType: 'image/webp',
		cacheControl: 'private, no-store',
	})
	const ok = await handler.handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(ok.status).toBe(200)
	expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
	expect(ok.headers.get('Content-Type')).toBe('image/webp')
	expect(mockModule.getMcpServerSettingById).toHaveBeenLastCalledWith({
		env: {},
		userId: 'user-1',
		id: 's1',
	})
})
