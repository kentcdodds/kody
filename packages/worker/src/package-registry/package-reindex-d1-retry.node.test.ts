import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	d1LongRunningExportMessage,
} from '#worker/d1-retry.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	buildSavedPackageEmbedText: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	getEntitySourceById: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listSavedPackagesPage: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	clearSavedPackageSearchIndexDebt: vi.fn(),
	getSavedPackageSearchIndexDebtGeneration: vi.fn(),
}))

vi.mock('#worker/vectorize/embedding.ts', () => ({
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
	loadPublishedEntitySource: vi.fn(),
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

vi.mock('./search-index-debt.ts', () => ({
	clearSavedPackageSearchIndexDebt: (...args: Array<unknown>) =>
		mockModule.clearSavedPackageSearchIndexDebt(...args),
	getSavedPackageSearchIndexDebtGeneration: (...args: Array<unknown>) =>
		mockModule.getSavedPackageSearchIndexDebtGeneration(...args),
}))

const { reindexSavedPackageVectors } = await import('./package-reindex.ts')

const exportError = () => new Error(`D1_ERROR: ${d1LongRunningExportMessage}.`)

function resetMocks() {
	mockModule.buildSavedPackageEmbedText.mockReset()
	mockModule.embedTextsForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.listSavedPackagesPage.mockReset()
	mockModule.clearSavedPackageSearchIndexDebt.mockReset()
	mockModule.clearSavedPackageSearchIndexDebt.mockResolvedValue(undefined)
	mockModule.getSavedPackageSearchIndexDebtGeneration.mockReset()
	mockModule.getSavedPackageSearchIndexDebtGeneration.mockResolvedValue(null)
	mockModule.loadPublishedEntityManifest.mockReset()
}

function createSourceRow(sourceId: string) {
	return {
		id: sourceId,
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: `package-${sourceId}`,
		repo_id: `repo-${sourceId}`,
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	}
}

function createSavedPackage(id: string) {
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

function stubSuccessfulManifestLoad(sourceId: string) {
	const source = createSourceRow(sourceId)
	const manifest = {
		name: '@user/pkg',
		exports: { '.': './index.ts' },
		kody: { id: 'pkg', description: 'Package' },
	}
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source,
		content: JSON.stringify(manifest),
		manifest,
	})
	mockModule.buildSavedPackageEmbedText.mockReturnValue('manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1, 0.2, 0.3]])
	return { source, manifest }
}

test('saved package reindex retries transient D1 export errors then reports exhaustion', async () => {
	resetMocks()
	const upsert = vi.fn()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
	} as Env
	const pkg = createSavedPackage('pkg-1')
	const { source } = stubSuccessfulManifestLoad(pkg.sourceId)
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listSavedPackagesPage.mockResolvedValue([pkg])
	mockModule.getEntitySourceById
		.mockRejectedValueOnce(exportError())
		.mockResolvedValueOnce(source)

	vi.useFakeTimers()
	try {
		const recoverPromise = reindexSavedPackageVectors(env, {
			baseUrl: 'https://kody.example.com',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(recoverPromise).resolves.toEqual({ upserted: 1 })
	} finally {
		vi.useRealTimers()
	}
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)

	resetMocks()
	consoleError.mockImplementation(() => {})
	const exhaustedUpsert = vi.fn()
	stubSuccessfulManifestLoad(pkg.sourceId)
	mockModule.getCapabilityVectorIndex.mockReturnValue({
		upsert: exhaustedUpsert,
	})
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listSavedPackagesPage.mockResolvedValue([pkg])
	mockModule.getEntitySourceById.mockRejectedValue(exportError())

	vi.useFakeTimers()
	try {
		const exhaustedPromise = reindexSavedPackageVectors(env, {
			baseUrl: 'https://kody.example.com',
		})
		const expectation = expect(exhaustedPromise).resolves.toEqual({
			upserted: 0,
			failed: 1,
			failures: [
				{
					id: 'package_pkg-1',
					phase: 'load',
					error: `D1_ERROR: ${d1LongRunningExportMessage}.`,
				},
			],
			failedIds: ['package_pkg-1'],
			error: '1 saved package vector(s) failed to reindex',
		})
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt++) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await expectation
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(
		d1LockRetryMaxAttempts,
	)
	expect(mockModule.loadPublishedEntityManifest).not.toHaveBeenCalled()
	expect(exhaustedUpsert).not.toHaveBeenCalled()
})
