import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
	embedTextsForVectorize: mockModule.embedTextsForVectorize,
	getCapabilityVectorIndex: mockModule.getCapabilityVectorIndex,
	isCapabilitySearchOffline: mockModule.isCapabilitySearchOffline,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: mockModule.loadPublishedEntityManifest,
	loadPublishedEntitySource: vi.fn(),
}))

vi.mock('./embed.ts', () => ({
	buildSavedPackageEmbedText: mockModule.buildSavedPackageEmbedText,
}))

vi.mock('./repo.ts', () => ({
	listSavedPackagesPage: mockModule.listSavedPackagesPage,
	savedPackageVectorId: (packageId: string) => `package_${packageId}`,
}))

vi.mock('./search-index-debt.ts', () => ({
	clearSavedPackageSearchIndexDebt: mockModule.clearSavedPackageSearchIndexDebt,
	getSavedPackageSearchIndexDebtGeneration:
		mockModule.getSavedPackageSearchIndexDebtGeneration,
}))

const { reindexSavedPackageVectors } = await import('./package-reindex.ts')

const exportErrorMessage = `D1_ERROR: ${d1LongRunningExportMessage}.`

const source = {
	id: 'source-pkg-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'package' as const,
	entity_id: 'package-source-pkg-1',
	repo_id: 'repo-source-pkg-1',
	published_commit: 'commit-1',
	indexed_commit: 'commit-1',
	manifest_path: 'package.json',
	source_root: '/',
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

/** One saved package whose manifest load succeeds once its entity source resolves. */
function setupMocks() {
	const upsert = vi.fn()
	const manifest = {
		name: '@user/pkg',
		exports: { '.': './index.ts' },
		kody: { id: 'pkg', description: 'Package' },
	}
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listSavedPackagesPage.mockResolvedValue([
		{
			id: 'pkg-1',
			userId: ownerIdFromStored('user-1'),
			name: '@user/pkg-1',
			kodyId: 'pkg-1',
			description: 'Package pkg-1',
			tags: [],
			searchText: null,
			sourceId: source.id,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	])
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source,
		content: JSON.stringify(manifest),
		manifest,
	})
	mockModule.buildSavedPackageEmbedText.mockReturnValue('manifest embed')
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1, 0.2, 0.3]])
	mockModule.clearSavedPackageSearchIndexDebt.mockResolvedValue(undefined)
	mockModule.getSavedPackageSearchIndexDebtGeneration.mockResolvedValue(null)
	return { upsert }
}

async function reindexWithFakeTimers(retryDelaysMs: Array<number>) {
	vi.useFakeTimers()
	try {
		const promise = reindexSavedPackageVectors(
			{ APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env,
			{ baseUrl: 'https://kody.example.com' },
		)
		for (const delayMs of retryDelaysMs) {
			await vi.advanceTimersByTimeAsync(delayMs)
		}
		return await promise
	} finally {
		vi.useRealTimers()
	}
}

test('saved package reindex retries a transient D1 export error on source lookup', async () => {
	const { upsert } = setupMocks()
	mockModule.getEntitySourceById
		.mockRejectedValueOnce(new Error(exportErrorMessage))
		.mockResolvedValueOnce(source)

	await expect(
		reindexWithFakeTimers([d1LockRetryBaseDelayMs]),
	).resolves.toEqual({ upserted: 1, complete: true, afterId: null })
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)
})

test('saved package reindex reports source lookup failures after the retry budget', async () => {
	consoleError.mockImplementation(() => {})
	const { upsert } = setupMocks()
	mockModule.getEntitySourceById.mockRejectedValue(
		new Error(exportErrorMessage),
	)

	await expect(
		reindexWithFakeTimers(
			Array.from(
				{ length: d1LockRetryMaxAttempts - 1 },
				(_, index) => d1LockRetryBaseDelayMs * 2 ** index,
			),
		),
	).resolves.toEqual({
		upserted: 0,
		complete: true,
		afterId: null,
		failed: 1,
		failures: [
			{ id: 'package_pkg-1', phase: 'load', error: exportErrorMessage },
		],
		failedIds: ['package_pkg-1'],
		error: '1 saved package vector(s) failed to reindex',
	})
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(
		d1LockRetryMaxAttempts,
	)
	expect(mockModule.loadPublishedEntityManifest).not.toHaveBeenCalled()
	expect(upsert).not.toHaveBeenCalled()
})
