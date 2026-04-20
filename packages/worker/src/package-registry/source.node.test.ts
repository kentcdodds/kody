import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	readMockArtifactSnapshot: vi.fn(),
	repoSessionRpc: vi.fn(),
	loadRepoSourceFilesFromSession: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	isLoopbackHostname: () => false,
	readMockArtifactSnapshot: (...args: Array<unknown>) =>
		mockModule.readMockArtifactSnapshot(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/repo/repo-codemode-execution.ts', () => ({
	loadRepoSourceFilesFromSession: (...args: Array<unknown>) =>
		mockModule.loadRepoSourceFilesFromSession(...args),
}))

const { loadPackageSourceBySourceId } = await import('./source.ts')

function createPackageSourceRow(input: {
	id: string
	publishedCommit: string | null
}) {
	return {
		id: input.id,
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: `package-${input.id}`,
		repo_id: `repo-${input.id}`,
		published_commit: input.publishedCommit,
		indexed_commit: input.publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	}
}

function createSessionClient(sessionId: string) {
	return {
		openSession: vi.fn(async () => ({
			id: sessionId,
		})),
		readFile: vi.fn(async () => ({
			content: JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'.': './index.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
					app: {
						entry: 'app.js',
					},
				},
			}),
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId,
			deleted: true,
		})),
	}
}

test('loadPackageSourceBySourceId reuses cached published package sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.readMockArtifactSnapshot.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.loadRepoSourceFilesFromSession.mockReset()

	const sessionClient = createSessionClient('session-published-1')
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-1',
			publishedCommit: 'commit-1',
		}),
	)
	mockModule.readMockArtifactSnapshot.mockResolvedValue(null)
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)
	mockModule.loadRepoSourceFilesFromSession.mockResolvedValue({
		'app.js': 'export default { async fetch() { return new Response("ok") } }',
		'index.js': 'export const value = "ok"',
	})

	const first = await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-1',
	})
	const second = await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-1',
	})

	expect(sessionClient.openSession).toHaveBeenCalledTimes(1)
	expect(mockModule.loadRepoSourceFilesFromSession).toHaveBeenCalledTimes(1)
	expect(sessionClient.discardSession).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
	expect(first.files).toEqual({
		'app.js': 'export default { async fetch() { return new Response("ok") } }',
		'index.js': 'export const value = "ok"',
		'package.json': JSON.stringify({
			name: '@kentcdodds/example-package',
			exports: {
				'.': './index.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
				app: {
					entry: 'app.js',
				},
			},
		}),
	})
})

test('loadPackageSourceBySourceId does not cache unpublished sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.readMockArtifactSnapshot.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.loadRepoSourceFilesFromSession.mockReset()

	const sessionClient = createSessionClient('session-unpublished-1')
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-unpublished-1',
			publishedCommit: null,
		}),
	)
	mockModule.readMockArtifactSnapshot.mockResolvedValue(null)
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)
	mockModule.loadRepoSourceFilesFromSession.mockResolvedValue({
		'app.js': 'export default { async fetch() { return new Response("ok") } }',
		'index.js': 'export const value = "ok"',
	})

	await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-unpublished-1',
	})
	await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-unpublished-1',
	})

	expect(sessionClient.openSession).toHaveBeenCalledTimes(2)
	expect(mockModule.loadRepoSourceFilesFromSession).toHaveBeenCalledTimes(2)
	expect(sessionClient.discardSession).toHaveBeenCalledTimes(2)
})

test('loadPackageSourceBySourceId shares the same in-flight published source load', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.readMockArtifactSnapshot.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.loadRepoSourceFilesFromSession.mockReset()

	const sessionClient = createSessionClient('session-published-concurrent')
	let resolveFiles: ((files: Record<string, string>) => void) | null = null
	const filesPromise = new Promise<Record<string, string>>((resolve) => {
		resolveFiles = resolve
	})

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-concurrent',
			publishedCommit: 'commit-concurrent-1',
		}),
	)
	mockModule.readMockArtifactSnapshot.mockResolvedValue(null)
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)
	mockModule.loadRepoSourceFilesFromSession.mockImplementation(
		async () => await filesPromise,
	)

	const firstPromise = loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-concurrent',
	})
	const secondPromise = loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-concurrent',
	})

	resolveFiles?.({
		'app.js': 'export default { async fetch() { return new Response("ok") } }',
		'index.js': 'export const value = "ok"',
	})

	const [first, second] = await Promise.all([firstPromise, secondPromise])

	expect(sessionClient.openSession).toHaveBeenCalledTimes(1)
	expect(mockModule.loadRepoSourceFilesFromSession).toHaveBeenCalledTimes(1)
	expect(sessionClient.discardSession).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
})
