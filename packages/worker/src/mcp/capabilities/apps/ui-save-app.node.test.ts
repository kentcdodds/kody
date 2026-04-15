import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getUiArtifactById: vi.fn(),
	updateUiArtifact: vi.fn(),
	insertUiArtifact: vi.fn(),
	deleteUiArtifact: vi.fn(),
	configureSavedAppRunner: vi.fn(),
	deleteSavedAppRunner: vi.fn(),
	upsertUiArtifactVector: vi.fn(),
	deleteUiArtifactVector: vi.fn(),
}))

vi.mock('#mcp/ui-artifacts-repo.ts', () => ({
	getUiArtifactById: (...args: Array<unknown>) =>
		mockModule.getUiArtifactById(...args),
	updateUiArtifact: (...args: Array<unknown>) =>
		mockModule.updateUiArtifact(...args),
	insertUiArtifact: (...args: Array<unknown>) =>
		mockModule.insertUiArtifact(...args),
	deleteUiArtifact: (...args: Array<unknown>) =>
		mockModule.deleteUiArtifact(...args),
}))

vi.mock('#mcp/app-runner.ts', () => ({
	configureSavedAppRunner: (...args: Array<unknown>) =>
		mockModule.configureSavedAppRunner(...args),
	deleteSavedAppRunner: (...args: Array<unknown>) =>
		mockModule.deleteSavedAppRunner(...args),
}))

vi.mock('#mcp/ui-artifacts-vectorize.ts', () => ({
	upsertUiArtifactVector: (...args: Array<unknown>) =>
		mockModule.upsertUiArtifactVector(...args),
	deleteUiArtifactVector: (...args: Array<unknown>) =>
		mockModule.deleteUiArtifactVector(...args),
}))

const { uiSaveAppCapability } = await import('./ui-save-app.ts')

test('ui_save_app updates preserve backend code unless the caller clears or replaces it', async () => {
	mockModule.getUiArtifactById.mockReset()
	mockModule.updateUiArtifact.mockReset()
	mockModule.insertUiArtifact.mockReset()
	mockModule.deleteUiArtifact.mockReset()
	mockModule.configureSavedAppRunner.mockReset()
	mockModule.deleteSavedAppRunner.mockReset()
	mockModule.upsertUiArtifactVector.mockReset()
	mockModule.deleteUiArtifactVector.mockReset()

	const initialServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v1" } }'
	const replacementServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v2" } }'

	let currentApp = {
		id: 'app-1',
		user_id: 'user-1',
		title: 'Patchable App',
		description: 'Saved app used to verify partial ui_save_app updates.',
		clientCode: '<main><h1>Patchable v1</h1></main>',
		serverCode: initialServerCode,
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
	}

	mockModule.getUiArtifactById.mockImplementation(async () => ({
		...currentApp,
	}))
	mockModule.updateUiArtifact.mockImplementation(
		async (
			_db: unknown,
			_userId: string,
			_appId: string,
			updates: Record<string, unknown>,
		) => {
			currentApp = {
				...currentApp,
				...(updates['title'] !== undefined
					? { title: updates['title'] as string }
					: {}),
				...(updates['description'] !== undefined
					? { description: updates['description'] as string }
					: {}),
				...(updates['clientCode'] !== undefined
					? { clientCode: updates['clientCode'] as string }
					: {}),
				...(updates['hidden'] !== undefined
					? { hidden: updates['hidden'] as boolean }
					: {}),
				...(updates['parameters'] !== undefined
					? { parameters: updates['parameters'] as string | null }
					: {}),
				...(updates['serverCode'] !== undefined
					? { serverCode: updates['serverCode'] as string | null }
					: {}),
				...(updates['serverCodeId'] !== undefined
					? { serverCodeId: updates['serverCodeId'] as string }
					: {}),
			}
			return { ...currentApp }
		},
	)

	const randomUuidSpy = vi.spyOn(crypto, 'randomUUID')
	randomUuidSpy.mockReturnValueOnce('server-code-v2')
	randomUuidSpy.mockReturnValueOnce('server-code-v3')

	try {
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-1', email: 'user@example.com' },
		})

		const preservedResult = await uiSaveAppCapability.handler(
			{
				app_id: 'app-1',
				clientCode: '<main><h1>Patchable v2</h1></main>',
			},
			{
				env: { APP_DB: {} } as Env,
				callerContext,
			},
		)
		expect(preservedResult).toEqual({
			app_id: 'app-1',
			server_code_id: 'server-code-v1',
			has_server_code: true,
			hosted_url: 'https://heykody.dev/ui/app-1',
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
		expect(mockModule.updateUiArtifact.mock.calls[0]?.[3]).toEqual({
			title: undefined,
			description: undefined,
			clientCode: '<main><h1>Patchable v2</h1></main>',
			hidden: undefined,
		})
		expect(mockModule.configureSavedAppRunner.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: initialServerCode,
				serverCodeId: 'server-code-v1',
			}),
		)

		const clearedResult = await uiSaveAppCapability.handler(
			{
				app_id: 'app-1',
				serverCode: null,
			},
			{
				env: { APP_DB: {} } as Env,
				callerContext,
			},
		)
		expect(clearedResult).toEqual({
			app_id: 'app-1',
			server_code_id: 'server-code-v2',
			has_server_code: false,
			hosted_url: 'https://heykody.dev/ui/app-1',
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
		expect(mockModule.updateUiArtifact.mock.calls[1]?.[3]).toEqual({
			title: undefined,
			description: undefined,
			clientCode: undefined,
			hidden: undefined,
			serverCode: null,
			serverCodeId: 'server-code-v2',
		})
		expect(mockModule.configureSavedAppRunner.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: null,
				serverCodeId: 'server-code-v2',
			}),
		)

		const replacedResult = await uiSaveAppCapability.handler(
			{
				app_id: 'app-1',
				serverCode: replacementServerCode,
			},
			{
				env: { APP_DB: {} } as Env,
				callerContext,
			},
		)
		expect(replacedResult).toEqual({
			app_id: 'app-1',
			server_code_id: 'server-code-v3',
			has_server_code: true,
			hosted_url: 'https://heykody.dev/ui/app-1',
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
		expect(mockModule.updateUiArtifact.mock.calls[2]?.[3]).toEqual({
			title: undefined,
			description: undefined,
			clientCode: undefined,
			hidden: undefined,
			serverCode: replacementServerCode,
			serverCodeId: 'server-code-v3',
		})
		expect(mockModule.configureSavedAppRunner.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: replacementServerCode,
				serverCodeId: 'server-code-v3',
			}),
		)
		expect(randomUuidSpy).toHaveBeenCalledTimes(2)
		expect(mockModule.deleteUiArtifactVector).toHaveBeenCalledTimes(3)
	} finally {
		randomUuidSpy.mockRestore()
	}
})
