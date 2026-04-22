import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	registerAppTool: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	createGeneratedUiAppSession: vi.fn(),
}))

vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: (...args: Array<unknown>) => mockModule.registerAppTool(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', async () => {
	const actual = await vi.importActual('#mcp/tools/memory-tool-context.ts')
	return {
		...actual,
		loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
			mockModule.loadRelevantMemoriesForTool(...args),
	}
})

vi.mock('#mcp/generated-ui-app-session.ts', () => ({
	createGeneratedUiAppSession: (...args: Array<unknown>) =>
		mockModule.createGeneratedUiAppSession(...args),
}))

const { registerOpenGeneratedUiTool } = await import('./open-generated-ui.ts')

async function getOpenGeneratedUiHandler() {
	mockModule.registerAppTool.mockClear()

	await registerOpenGeneratedUiTool({
		server: {} as never,
		getEnv: vi.fn(() => ({
			APP_DB: {} as D1Database,
		})),
		getCallerContext: vi.fn(() => ({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-123',
				email: 'user@example.com',
			},
			homeConnectorId: null,
		})),
		requireDomain: vi.fn(() => 'https://example.com'),
	} as never)

	expect(mockModule.registerAppTool).toHaveBeenCalledTimes(1)
	const [, , handler] = mockModule.registerAppTool.mock.calls[0] ?? []
	expect(typeof handler).toBe('function')
	return handler as (args: Record<string, unknown>) => Promise<{
		structuredContent: {
			hostedUrl?: string | null
			appId?: string | null
		}
	}>
}

test('open_generated_ui reopens saved package apps by kody_id', async () => {
	const handler = await getOpenGeneratedUiHandler()
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce({
		id: 'package-123',
		userId: 'user-123',
		name: '@kody/observed',
		kodyId: 'observed-package',
		description: 'Observed package app',
		tags: ['ui'],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		createdAt: '2026-04-21T00:00:00.000Z',
		updatedAt: '2026-04-21T00:00:00.000Z',
	})

	const response = await handler({
		kody_id: 'observed-package',
	})

	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: 'user-123',
			kodyId: 'observed-package',
		},
	)
	expect(response.structuredContent).toMatchObject({
		appId: 'package-123',
		hostedUrl: 'https://example.com/packages/observed-package',
	})
})

