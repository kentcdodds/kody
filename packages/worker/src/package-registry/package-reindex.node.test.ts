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

test('saved package reindex embeds full manifests with user-scoped metadata', async () => {
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
