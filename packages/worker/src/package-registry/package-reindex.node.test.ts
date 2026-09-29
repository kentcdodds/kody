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
	clearSavedPackageSearchIndexDebt: vi.fn(),
	getSavedPackageSearchIndexDebtGeneration: vi.fn(),
}))

vi.mock('#worker/vectorize/embedding.ts', () => ({
	embedTextsForVectorize: mockModule.embedTextsForVectorize,
	getCapabilityVectorIndex: mockModule.getCapabilityVectorIndex,
	isCapabilitySearchOffline: mockModule.isCapabilitySearchOffline,
}))

vi.mock('./embed.ts', () => ({
	buildSavedPackageEmbedText: mockModule.buildSavedPackageEmbedText,
}))

vi.mock('./repo.ts', () => ({
	listSavedPackagesPage: mockModule.listSavedPackagesPage,
	savedPackageVectorId: (packageId: string) => `package_${packageId}`,
}))

vi.mock('./source.ts', () => ({
	loadPackageManifestBySourceId: mockModule.loadPackageManifestBySourceId,
}))

vi.mock('./search-index-debt.ts', () => ({
	clearSavedPackageSearchIndexDebt: mockModule.clearSavedPackageSearchIndexDebt,
	getSavedPackageSearchIndexDebtGeneration:
		mockModule.getSavedPackageSearchIndexDebtGeneration,
}))

const { reindexSavedPackageVectors } = await import('./package-reindex.ts')

const baseUrl = 'https://kody.example.com'
const longRunningExportError = () =>
	new Error('D1_ERROR: Currently processing a long-running export.')

function setupMocks() {
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
	mockModule.clearSavedPackageSearchIndexDebt.mockResolvedValue(undefined)
	mockModule.getSavedPackageSearchIndexDebtGeneration.mockResolvedValue(null)
	return { upsert }
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

function buildSavedPackages(count: number, padLength: number) {
	return Array.from({ length: count }, (_, index) =>
		buildSavedPackage(`pkg-${String(index).padStart(padLength, '0')}`),
	)
}

function reindex(
	options: { afterId?: string; deadlineMs?: number } = {},
	env = { APP_DB: {} } as Env,
) {
	return reindexSavedPackageVectors(env, { baseUrl, ...options })
}

test('saved package reindex embeds full manifests with user-scoped metadata and skips failed loads', async () => {
	consoleError.mockImplementation(() => {})
	const { upsert } = setupMocks()
	const env = { APP_DB: {} } as Env
	const manifest = {
		name: '@user/weather',
		exports: { '.': './index.ts' },
		kody: { id: 'weather', description: 'Weather package' },
	}
	mockModule.listSavedPackagesPage.mockResolvedValue([
		buildSavedPackage('pkg-bad'),
		buildSavedPackage('pkg-good'),
	])
	mockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-pkg-bad') {
				throw new Error('manifest missing')
			}
			return { manifest }
		},
	)
	mockModule.buildSavedPackageEmbedText.mockReturnValue('full manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1, 0.2, 0.3]])

	await expect(reindex({}, env)).resolves.toEqual({
		upserted: 1,
		complete: true,
		afterId: null,
		failed: 1,
		failures: [
			{ id: 'package_pkg-bad', phase: 'load', error: 'manifest missing' },
		],
		failedIds: ['package_pkg-bad'],
		warning: '1 saved package vector(s) failed to reindex',
	})

	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenLastCalledWith({
		env,
		baseUrl,
		userId: 'user-1',
		sourceId: 'source-pkg-good',
	})
	expect(mockModule.buildSavedPackageEmbedText).toHaveBeenCalledWith(manifest)
	expect(mockModule.embedTextsForVectorize).toHaveBeenCalledWith(env, [
		'full manifest embed',
	])
	expect(upsert).toHaveBeenCalledWith([
		{
			id: 'package_pkg-good',
			values: [0.1, 0.2, 0.3],
			namespace: 'user-1',
			metadata: { kind: 'package', userId: 'user-1' },
		},
	])
})

test('saved package reindex keeps debt for failed vectors beyond the failure sample cap', async () => {
	consoleError.mockImplementation(() => {})
	setupMocks()
	mockModule.embedTextsForVectorize.mockRejectedValue(new Error('ai down'))
	mockModule.listSavedPackagesPage.mockResolvedValue(buildSavedPackages(25, 2))

	await expect(reindex()).resolves.toMatchObject({ upserted: 0, failed: 25 })
	expect(mockModule.clearSavedPackageSearchIndexDebt).not.toHaveBeenCalled()
})

test('saved package reindex retries a transient D1 export error on page listing', async () => {
	const { upsert } = setupMocks()
	mockModule.listSavedPackagesPage
		.mockRejectedValueOnce(longRunningExportError())
		.mockResolvedValueOnce([buildSavedPackage('pkg-1')])

	vi.useFakeTimers()
	try {
		const resultPromise = reindex()
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toEqual({
			upserted: 1,
			complete: true,
			afterId: null,
		})
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.listSavedPackagesPage).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)
})

test('saved package reindex surfaces page listing failures after the retry budget', async () => {
	setupMocks()
	mockModule.listSavedPackagesPage.mockRejectedValue(longRunningExportError())

	vi.useFakeTimers()
	try {
		const resultPromise = reindex()
		// Attach before advancing timers so the rejection is not unhandled.
		// oxlint-disable-next-line vitest/valid-expect
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
	const { upsert } = setupMocks()
	// The first page fills the requested limit, forcing a second page fetch.
	mockModule.listSavedPackagesPage
		.mockImplementationOnce(async (_db: unknown, input: { limit: number }) =>
			buildSavedPackages(input.limit, 4),
		)
		.mockImplementationOnce(async () => [buildSavedPackage('pkg-last')])

	await expect(reindex()).resolves.toEqual({
		upserted: 201,
		complete: true,
		afterId: null,
	})

	expect(
		mockModule.listSavedPackagesPage.mock.calls.map(([, page]) => page),
	).toEqual([
		{ afterId: null, limit: 200 },
		{ afterId: 'pkg-0199', limit: 200 },
	])
	const upsertedIds = upsert.mock.calls.flatMap(([vectors]) =>
		vectors.map((vector) => vector.id),
	)
	expect(upsertedIds).toHaveLength(201)
	expect(new Set(upsertedIds).size).toBe(201)
})

test('saved package reindex stops mid-page at the deadline and resumes', async () => {
	const { upsert } = setupMocks()
	mockModule.listSavedPackagesPage.mockResolvedValueOnce(
		['pkg-a', 'pkg-b', 'pkg-c'].map(buildSavedPackage),
	)

	await expect(reindex({ deadlineMs: 0 })).resolves.toEqual({
		upserted: 1,
		complete: false,
		afterId: 'pkg-a',
	})
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledTimes(1)
	expect(upsert).toHaveBeenCalledTimes(1)

	mockModule.listSavedPackagesPage.mockResolvedValueOnce(
		['pkg-b', 'pkg-c'].map(buildSavedPackage),
	)
	await expect(reindex({ afterId: 'pkg-a' })).resolves.toEqual({
		upserted: 2,
		complete: true,
		afterId: null,
	})
	expect(mockModule.listSavedPackagesPage).toHaveBeenLastCalledWith(
		expect.anything(),
		{ afterId: 'pkg-a', limit: 200 },
	)
})

test('saved package reindex flushes upsert chunks and honors the deadline after a flush', async () => {
	const { upsert } = setupMocks()
	mockModule.listSavedPackagesPage.mockResolvedValueOnce(
		buildSavedPackages(20, 2),
	)
	let now = 1_000
	const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: unknown, texts: Array<string>) => {
			now = 3_000
			return texts.map(() => [0.1])
		},
	)

	try {
		await expect(reindex({ deadlineMs: 2_000 })).resolves.toEqual({
			upserted: 16,
			complete: false,
			afterId: 'pkg-15',
		})
	} finally {
		nowSpy.mockRestore()
	}

	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledTimes(16)
	expect(upsert).toHaveBeenCalledTimes(1)
	expect(upsert.mock.calls[0]?.[0]).toHaveLength(16)
})
