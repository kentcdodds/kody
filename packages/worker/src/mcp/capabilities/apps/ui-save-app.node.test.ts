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
	resolveSavedAppSource: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
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

vi.mock('#worker/repo/app-source.ts', () => ({
	resolveSavedAppSource: (...args: Array<unknown>) =>
		mockModule.resolveSavedAppSource(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
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
	mockModule.resolveSavedAppSource.mockReset()
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()

	const initialServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v1" } }'
	const replacementServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v2" } }'
	const appDb = {} as D1Database

	let currentApp = {
		id: 'app-1',
		user_id: 'user-1',
		title: 'Patchable App',
		description: 'Saved app used to verify partial ui_save_app updates.',
		sourceId: 'source-app-1',
		hasServerCode: true,
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
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-app-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'app-app-1',
		published_commit: 'server-code-v1',
		indexed_commit: 'server-code-v1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		bootstrapAccess: null,
	})
	mockModule.syncArtifactSourceSnapshot
		.mockResolvedValueOnce('server-code-v2')
		.mockResolvedValueOnce('server-code-v3')
		.mockResolvedValueOnce('server-code-v4')
	mockModule.resolveSavedAppSource.mockImplementation(async () => ({
		id: currentApp.id,
		title: currentApp.title,
		description: currentApp.description,
		hidden: currentApp.hidden,
		parameters: [
			{
				name: 'team',
				description: 'Team slug',
				type: 'string',
				required: true,
			},
		],
		clientCode:
			(currentApp as typeof currentApp & { resolvedClientCode?: string })
				.resolvedClientCode ?? '<main><h1>Patchable v1</h1></main>',
		serverCode:
			(currentApp as typeof currentApp & { resolvedServerCode?: string | null })
				.resolvedServerCode ?? initialServerCode,
		serverCodeId:
			(currentApp as typeof currentApp & { resolvedServerCodeId?: string | null })
				.resolvedServerCodeId ?? 'server-code-v1',
		sourceId: currentApp.sourceId,
		publishedCommit:
			(currentApp as typeof currentApp & { publishedCommit?: string | null })
				.publishedCommit ?? 'server-code-v1',
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
				...(updates['hidden'] !== undefined
					? { hidden: updates['hidden'] as boolean }
					: {}),
				...(updates['parameters'] !== undefined
					? { parameters: updates['parameters'] as string | null }
					: {}),
				...(updates['sourceId'] !== undefined
					? { sourceId: updates['sourceId'] as string }
					: {}),
				...(updates['hasServerCode'] !== undefined
					? { hasServerCode: updates['hasServerCode'] as boolean }
					: {}),
			}
			if (updates['hasServerCode'] !== undefined) {
				;(currentApp as typeof currentApp & { resolvedServerCode?: string | null })
					.resolvedServerCode =
						updates['hasServerCode'] === true ? initialServerCode : null
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
				env: {
					APP_DB: appDb,
					CLOUDFLARE_ACCOUNT_ID: 'acct',
					CLOUDFLARE_API_TOKEN: 'token',
				} as Env,
				callerContext,
			},
		)
		expect(preservedResult).toEqual({
			app_id: 'app-1',
			server_code_id: expect.any(String),
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
			sourceId: expect.any(String),
			hasServerCode: true,
			hidden: undefined,
		})
		expect(mockModule.configureSavedAppRunner.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: initialServerCode,
				serverCodeId: expect.any(String),
			}),
		)

		const clearedResult = await uiSaveAppCapability.handler(
			{
				app_id: 'app-1',
				serverCode: null,
			},
			{
				env: {
					APP_DB: appDb,
					CLOUDFLARE_ACCOUNT_ID: 'acct',
					CLOUDFLARE_API_TOKEN: 'token',
				} as Env,
				callerContext,
			},
		)
		expect(clearedResult).toEqual({
			app_id: 'app-1',
			server_code_id: expect.any(String),
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
		expect(mockModule.updateUiArtifact.mock.calls[1]?.[3]).toEqual(
			expect.objectContaining({
				title: undefined,
				description: undefined,
				sourceId: expect.any(String),
				hidden: undefined,
				hasServerCode: false,
			}),
		)
		expect(mockModule.configureSavedAppRunner.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: null,
				serverCodeId: expect.any(String),
			}),
		)

		const replacedResult = await uiSaveAppCapability.handler(
			{
				app_id: 'app-1',
				serverCode: replacementServerCode,
			},
			{
				env: {
					APP_DB: appDb,
					CLOUDFLARE_ACCOUNT_ID: 'acct',
					CLOUDFLARE_API_TOKEN: 'token',
				} as Env,
				callerContext,
			},
		)
		expect(replacedResult).toEqual({
			app_id: 'app-1',
			server_code_id: expect.any(String),
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
		expect(mockModule.updateUiArtifact.mock.calls[2]?.[3]).toEqual(
			expect.objectContaining({
				title: undefined,
				description: undefined,
				sourceId: expect.any(String),
				hidden: undefined,
				hasServerCode: true,
			}),
		)
		expect(mockModule.configureSavedAppRunner.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				appId: 'app-1',
				serverCode: replacementServerCode,
				serverCodeId: expect.any(String),
			}),
		)
		expect(mockModule.deleteUiArtifactVector).toHaveBeenCalledTimes(3)
	} finally {
		randomUuidSpy.mockRestore()
	}
})
