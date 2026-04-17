import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AppSourceModule from '#worker/repo/app-source.ts'
import type * as EntitySourcesModule from '#worker/repo/entity-sources.ts'
import type * as SourceServiceModule from '#worker/repo/source-service.ts'

const mockModule = vi.hoisted(() => ({
	getUiArtifactById: vi.fn(),
	updateUiArtifact: vi.fn(),
	insertUiArtifact: vi.fn(),
	deleteUiArtifact: vi.fn(),
	configureSavedAppRunner: vi.fn(),
	deleteSavedAppRunner: vi.fn(),
	upsertUiArtifactVector: vi.fn(),
	deleteUiArtifactVector: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn(),
	resolveSavedAppSource: vi.fn(),
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

vi.mock('#worker/repo/source-service.ts', async () => {
	const actual =
		await vi.importActual<typeof SourceServiceModule>(
			'#worker/repo/source-service.ts',
		)
	return {
		...actual,
		ensureEntitySource: (...args: Array<unknown>) =>
			mockModule.ensureEntitySource(...args),
	}
})

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', async () => {
	const actual =
		await vi.importActual<typeof EntitySourcesModule>(
			'#worker/repo/entity-sources.ts',
		)
	return {
		...actual,
		getEntitySourceById: (...args: Array<unknown>) =>
			mockModule.getEntitySourceById(...args),
		updateEntitySource: (...args: Array<unknown>) =>
			mockModule.updateEntitySource(...args),
	}
})

vi.mock('#worker/repo/app-source.ts', async () => {
	const actual =
		await vi.importActual<typeof AppSourceModule>(
			'#worker/repo/app-source.ts',
		)
	return {
		...actual,
		resolveSavedAppSource: (...args: Array<unknown>) =>
			mockModule.resolveSavedAppSource(...args),
	}
})

const { uiSaveAppCapability } = await import('./ui-save-app.ts')

function resetMocks() {
	mockModule.getUiArtifactById.mockReset()
	mockModule.updateUiArtifact.mockReset()
	mockModule.insertUiArtifact.mockReset()
	mockModule.deleteUiArtifact.mockReset()
	mockModule.configureSavedAppRunner.mockReset()
	mockModule.deleteSavedAppRunner.mockReset()
	mockModule.upsertUiArtifactVector.mockReset()
	mockModule.deleteUiArtifactVector.mockReset()
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.resolveSavedAppSource.mockReset()
}

test('ui_save_app creates a repo-backed saved app and stores metadata projection only', async () => {
	resetMocks()

	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		published_commit: null,
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-1')
	mockModule.insertUiArtifact.mockResolvedValue(undefined)
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		published_commit: 'commit-1',
	})
	mockModule.configureSavedAppRunner.mockResolvedValue(undefined)
	mockModule.upsertUiArtifactVector.mockResolvedValue(undefined)

	const result = await uiSaveAppCapability.handler(
		{
			title: 'Counter app',
			description: 'Counts things',
			clientCode: '<main>counter</main>',
			serverCode:
				'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}',
			hidden: false,
		},
		{
			env: {
				APP_DB: {
					prepare: vi.fn(),
				},
				ARTIFACTS: {},
				REPO_SESSION: {},
			} as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
		}),
	)
	expect(mockModule.insertUiArtifact).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			title: 'Counter app',
			description: 'Counts things',
			sourceId: 'source-1',
			hidden: false,
		}),
	)
	expect(mockModule.configureSavedAppRunner).toHaveBeenCalledWith(
		expect.objectContaining({
			appId: expect.any(String),
			serverCode: null,
			serverCodeId: 'commit-1',
		}),
	)
	expect(result).toEqual({
		app_id: expect.any(String),
		server_code_id: 'commit-1',
		has_server_code: true,
		hosted_url: expect.stringMatching(/^https:\/\/heykody\.dev\/ui\//),
		parameters: null,
		hidden: false,
	})
})

test('ui_save_app updates an existing app by reusing repo-backed source content', async () => {
	resetMocks()

	mockModule.getUiArtifactById.mockResolvedValue({
		id: 'app-1',
		user_id: 'user-1',
		title: 'Existing app',
		description: 'Existing description',
		sourceId: 'source-1',
		parameters: JSON.stringify([
			{
				name: 'team',
				description: 'Team slug',
				type: 'string',
				required: true,
			},
		]),
		hidden: true,
		created_at: '2026-04-17T00:00:00.000Z',
		updated_at: '2026-04-17T00:00:00.000Z',
	})
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		published_commit: 'commit-1',
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		published_commit: 'commit-1',
	})
	mockModule.resolveSavedAppSource.mockResolvedValue({
		title: 'Existing app',
		description: 'Existing description',
		hidden: true,
		parameters: [
			{
				name: 'team',
				description: 'Team slug',
				type: 'string',
				required: true,
			},
		],
		clientCode: '<main>existing</main>',
		serverCode:
			'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}',
		serverCodeId: 'commit-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-2')
	mockModule.updateUiArtifact.mockResolvedValue(true)
	mockModule.configureSavedAppRunner.mockResolvedValue(undefined)
	mockModule.deleteUiArtifactVector.mockResolvedValue(undefined)

	const result = await uiSaveAppCapability.handler(
		{
			app_id: 'app-1',
			description: 'Updated description',
			serverCode: null,
		},
		{
			env: {
				APP_DB: {
					prepare: vi.fn(),
				},
				ARTIFACTS: {},
				REPO_SESSION: {},
			} as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.resolveSavedAppSource).toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
		}),
	)
	expect(mockModule.updateUiArtifact).toHaveBeenCalledWith(
		expect.anything(),
		'user-1',
		'app-1',
		expect.objectContaining({
			description: 'Updated description',
			sourceId: 'source-1',
			hidden: true,
		}),
	)
	expect(result).toEqual({
		app_id: 'app-1',
		server_code_id: 'commit-1',
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
})
