import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	buildSavedPackageEmbedText: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listAllSavedPackages: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#mcp/capabilities/capability-search.ts', () => ({
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

vi.mock('./embed.ts', () => ({
	buildSavedPackageEmbedText: (...args: Array<unknown>) =>
		mockModule.buildSavedPackageEmbedText(...args),
}))

vi.mock('./repo.ts', () => ({
	listAllSavedPackages: (...args: Array<unknown>) =>
		mockModule.listAllSavedPackages(...args),
	savedPackageVectorId: (packageId: string) => `package_${packageId}`,
}))

vi.mock('./source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

const { reindexSavedPackageVectors } = await import('./package-reindex.ts')

function resetMocks() {
	mockModule.buildSavedPackageEmbedText.mockReset()
	mockModule.embedTextsForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.listAllSavedPackages.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
}

test('saved package reindex embeds full manifests with user-scoped metadata', async () => {
	resetMocks()
	const upsert = vi.fn()
	const env = {
		APP_DB: {},
	} as Env
	const manifest = {
		name: '@user/weather',
		exports: {
			'.': './index.ts',
		},
		kody: {
			id: 'weather',
			description: 'Weather package',
		},
	}
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listAllSavedPackages.mockResolvedValue([
		{
			id: 'pkg-1',
			userId: 'user-1',
			name: '@user/weather',
			kodyId: 'weather',
			description: 'Weather package',
			tags: ['weather'],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	])
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({ manifest })
	mockModule.buildSavedPackageEmbedText.mockReturnValue('full manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1, 0.2, 0.3]])

	await expect(
		reindexSavedPackageVectors(env, {
			baseUrl: 'https://kody.example.com',
		}),
	).resolves.toEqual({ upserted: 1 })

	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://kody.example.com',
		userId: 'user-1',
		sourceId: 'source-1',
	})
	expect(mockModule.buildSavedPackageEmbedText).toHaveBeenCalledWith(manifest)
	expect(mockModule.embedTextsForVectorize).toHaveBeenCalledWith(env, [
		'full manifest embed',
	])
	expect(upsert).toHaveBeenCalledWith([
		{
			id: 'package_pkg-1',
			values: [0.1, 0.2, 0.3],
			metadata: {
				kind: 'package',
				userId: 'user-1',
			},
		},
	])
})

test('saved package reindex skips failed manifest loads and continues the batch', async () => {
	resetMocks()
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const upsert = vi.fn()
	const env = {
		APP_DB: {},
	} as Env
	const manifest = {
		name: '@user/tasks',
		exports: {
			'.': './index.ts',
		},
		kody: {
			id: 'tasks',
			description: 'Tasks package',
		},
	}
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listAllSavedPackages.mockResolvedValue([
		{
			id: 'pkg-bad',
			userId: 'user-1',
			name: '@user/bad',
			kodyId: 'bad',
			description: 'Bad package',
			tags: [],
			searchText: null,
			sourceId: 'source-bad',
			hasApp: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'pkg-good',
			userId: 'user-1',
			name: '@user/tasks',
			kodyId: 'tasks',
			description: 'Tasks package',
			tags: ['tasks'],
			searchText: null,
			sourceId: 'source-good',
			hasApp: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	])
	mockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-bad') {
				throw new Error('manifest missing')
			}
			return { manifest }
		},
	)
	mockModule.buildSavedPackageEmbedText.mockReturnValue('tasks manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.4, 0.5, 0.6]])

	try {
		await expect(
			reindexSavedPackageVectors(env, {
				baseUrl: 'https://kody.example.com',
			}),
		).resolves.toEqual({
			upserted: 1,
			failed: 1,
			failures: [
				{
					id: 'package_pkg-bad',
					phase: 'load',
					error: 'manifest missing',
				},
			],
			warning: '1 saved package vector(s) failed to reindex',
		})

		expect(mockModule.embedTextsForVectorize).toHaveBeenCalledWith(env, [
			'tasks manifest embed',
		])
		expect(upsert).toHaveBeenCalledWith([
			{
				id: 'package_pkg-good',
				values: [0.4, 0.5, 0.6],
				metadata: {
					kind: 'package',
					userId: 'user-1',
				},
			},
		])
	} finally {
		consoleError.mockRestore()
	}
})
