import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	syncSavedAppRunnerFromDb: vi.fn(),
	execSavedAppRunnerServer: vi.fn(),
	exportSavedAppRunnerStorage: vi.fn(),
	getUiArtifactById: vi.fn(),
}))

vi.mock('#mcp/app-runner.ts', () => ({
	syncSavedAppRunnerFromDb: (...args: Array<unknown>) =>
		mockModule.syncSavedAppRunnerFromDb(...args),
	execSavedAppRunnerServer: (...args: Array<unknown>) =>
		mockModule.execSavedAppRunnerServer(...args),
	exportSavedAppRunnerStorage: (...args: Array<unknown>) =>
		mockModule.exportSavedAppRunnerStorage(...args),
}))

vi.mock('#mcp/ui-artifacts-repo.ts', () => ({
	getUiArtifactById: (...args: Array<unknown>) =>
		mockModule.getUiArtifactById(...args),
}))

const { appServerExecCapability } = await import('./app-server-exec.ts')
const { appStorageExportCapability } = await import('./app-storage-export.ts')
const { uiLoadAppSourceCapability } = await import('./ui-load-app-source.ts')

test('app_server_exec syncs the runner and normalizes the runner response', async () => {
	mockModule.syncSavedAppRunnerFromDb.mockReset()
	mockModule.execSavedAppRunnerServer.mockReset()
	mockModule.exportSavedAppRunnerStorage.mockReset()
	mockModule.getUiArtifactById.mockReset()

	mockModule.syncSavedAppRunnerFromDb.mockResolvedValueOnce({
		id: 'app-1',
	})
	mockModule.execSavedAppRunnerServer.mockResolvedValueOnce({
		appId: 'app-1',
		facetName: 'main',
		result: { count: 3 },
	})

	const result = await appServerExecCapability.handler(
		{
			app_id: 'app-1',
			code: 'return await app.call("incrementBy", params.amount ?? 1)',
			params: { amount: 3 },
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.syncSavedAppRunnerFromDb).toHaveBeenCalledWith({
		env: {},
		appId: 'app-1',
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
	})
	expect(mockModule.execSavedAppRunnerServer).toHaveBeenCalledWith({
		env: {},
		appId: 'app-1',
		facetName: 'main',
		code: 'return await app.call("incrementBy", params.amount ?? 1)',
		params: { amount: 3 },
	})
	expect(result).toEqual({
		ok: true,
		app_id: 'app-1',
		facet_name: 'main',
		result: { count: 3 },
	})
})

test('app_storage_export forwards pagination options to the runner export helper', async () => {
	mockModule.syncSavedAppRunnerFromDb.mockReset()
	mockModule.execSavedAppRunnerServer.mockReset()
	mockModule.exportSavedAppRunnerStorage.mockReset()
	mockModule.getUiArtifactById.mockReset()

	mockModule.syncSavedAppRunnerFromDb.mockResolvedValueOnce({
		id: 'app-1',
	})
	mockModule.exportSavedAppRunnerStorage.mockResolvedValueOnce({
		appId: 'app-1',
		facetName: 'analytics',
		export: {
			entries: [{ key: 'count', value: 3 }],
			estimatedBytes: 128,
			truncated: true,
			nextStartAfter: 'count',
			pageSize: 1,
		},
	})

	const result = await appStorageExportCapability.handler(
		{
			app_id: 'app-1',
			facet_name: 'analytics',
			page_size: 1,
			start_after: 'count',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.syncSavedAppRunnerFromDb).toHaveBeenCalledWith({
		env: {},
		appId: 'app-1',
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
	})
	expect(mockModule.exportSavedAppRunnerStorage).toHaveBeenCalledWith({
		env: {},
		appId: 'app-1',
		facetName: 'analytics',
		pageSize: 1,
		startAfter: 'count',
	})
	expect(result).toEqual({
		ok: true,
		app_id: 'app-1',
		facet_name: 'analytics',
		export: {
			entries: [{ key: 'count', value: 3 }],
			estimatedBytes: 128,
			truncated: true,
			nextStartAfter: 'count',
			pageSize: 1,
		},
	})
})

test('ui_load_app_source returns saved source for the authenticated user', async () => {
	mockModule.syncSavedAppRunnerFromDb.mockReset()
	mockModule.execSavedAppRunnerServer.mockReset()
	mockModule.exportSavedAppRunnerStorage.mockReset()
	mockModule.getUiArtifactById.mockReset()

	mockModule.getUiArtifactById.mockResolvedValueOnce({
		id: 'app-1',
		title: 'Patchable App',
		description: 'Saved app source',
		clientCode: '<main><h1>Saved</h1></main>',
		serverCode:
			'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}',
		serverCodeId: 'server-code-v1',
		parameters: JSON.stringify([
			{
				name: 'team',
				description: 'Team slug',
				type: 'string',
				required: true,
			},
		]),
		hidden: true,
	})

	const result = await uiLoadAppSourceCapability.handler(
		{
			app_id: 'app-1',
		},
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.getUiArtifactById).toHaveBeenCalledWith(
		{},
		'user-1',
		'app-1',
	)
	expect(result).toEqual({
		app_id: 'app-1',
		title: 'Patchable App',
		description: 'Saved app source',
		client_code: '<main><h1>Saved</h1></main>',
		server_code:
			'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}',
		server_code_id: 'server-code-v1',
		parameters: [
			{
				name: 'team',
				description: 'Team slug',
				type: 'string',
				required: true,
			},
		],
		hidden: true,
	})
})
