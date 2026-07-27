import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
} from '#worker/d1-retry.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	buildSavedPackageEmbedText: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listSavedPackagesPage: vi.fn(),
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
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesPage(...args),
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
	mockModule.listSavedPackagesPage.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
}

function buildSavedPackage(id: string) {
	return {
		id,
		userId: 'user-1',
		name: `@user/${id}`,
		kodyId: id,
		description: `Package ${id}`,
		tags: [],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
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
	mockModule.listSavedPackagesPage.mockResolvedValue([
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
			hidden: false,
			isPrivate: false,
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
	consoleError.mockImplementation(() => {})
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
	mockModule.listSavedPackagesPage.mockResolvedValue([
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
			hidden: false,
			isPrivate: false,
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
			hidden: false,
			isPrivate: false,
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
})

test('saved package reindex retries a transient D1 export error on page listing', async () => {
	resetMocks()
	const upsert = vi.fn()
	const env = { APP_DB: {} } as Env
	const pkg = buildSavedPackage('pkg-1')
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: { name: pkg.name },
	})
	mockModule.buildSavedPackageEmbedText.mockReturnValue('manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1]])
	mockModule.listSavedPackagesPage
		.mockRejectedValueOnce(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)
		.mockResolvedValueOnce([pkg])

	vi.useFakeTimers()
	try {
		const resultPromise = reindexSavedPackageVectors(env, {
			baseUrl: 'https://kody.example.com',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toEqual({ upserted: 1 })
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.listSavedPackagesPage).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)
})

test('saved package reindex surfaces page listing failures after the retry budget', async () => {
	resetMocks()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert: vi.fn() })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listSavedPackagesPage.mockRejectedValue(
		new Error('D1_ERROR: Currently processing a long-running export.'),
	)

	vi.useFakeTimers()
	try {
		const resultPromise = reindexSavedPackageVectors({ APP_DB: {} } as Env, {
			baseUrl: 'https://kody.example.com',
		})
		const expectation = expect(resultPromise).rejects.toThrow(
			'Currently processing a long-running export',
		)
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt++) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await expectation
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.listSavedPackagesPage).toHaveBeenCalledTimes(
		d1LockRetryMaxAttempts,
	)
	expect(mockModule.loadPackageManifestBySourceId).not.toHaveBeenCalled()
})

test('saved package reindex walks keyset pages and merges the page results', async () => {
	resetMocks()
	const upsert = vi.fn(async (_vectors: Array<{ id: string }>) => {})
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: { name: '@user/pkg' },
	})
	mockModule.buildSavedPackageEmbedText.mockReturnValue('manifest embed')
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: unknown, texts: Array<string>) => texts.map(() => [0.1]),
	)
	// The first page fills the requested limit, forcing a second page fetch.
	mockModule.listSavedPackagesPage.mockImplementationOnce(
		async (_db: unknown, input: { afterId: string | null; limit: number }) =>
			Array.from({ length: input.limit }, (_, index) =>
				buildSavedPackage(`pkg-${String(index).padStart(4, '0')}`),
			),
	)
	mockModule.listSavedPackagesPage.mockImplementationOnce(async () => [
		buildSavedPackage('pkg-last'),
	])

	await expect(
		reindexSavedPackageVectors({ APP_DB: {} } as Env, {
			baseUrl: 'https://kody.example.com',
		}),
	).resolves.toEqual({ upserted: 201 })

	expect(mockModule.listSavedPackagesPage).toHaveBeenCalledTimes(2)
	expect(mockModule.listSavedPackagesPage).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		{ afterId: null, limit: 200 },
	)
	expect(mockModule.listSavedPackagesPage).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		{ afterId: 'pkg-0199', limit: 200 },
	)
	const upsertedIds = upsert.mock.calls.flatMap(([vectors]) =>
		vectors.map((vector) => vector.id),
	)
	expect(upsertedIds).toHaveLength(201)
	expect(new Set(upsertedIds).size).toBe(201)
})
