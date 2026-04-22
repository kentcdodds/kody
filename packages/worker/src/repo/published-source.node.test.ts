import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	readMockArtifactSnapshot: vi.fn(),
	loadPublishedSourceManifestSnapshot: vi.fn(),
	persistPublishedSourceManifestSnapshot: vi.fn(),
	loadPublishedSourceSnapshot: vi.fn(),
	persistPublishedSourceSnapshot: vi.fn(),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('./artifacts.ts', () => ({
	readMockArtifactSnapshot: (...args: Array<unknown>) =>
		mockModule.readMockArtifactSnapshot(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	loadPublishedSourceManifestSnapshot: (...args: Array<unknown>) =>
		mockModule.loadPublishedSourceManifestSnapshot(...args),
	persistPublishedSourceManifestSnapshot: (...args: Array<unknown>) =>
		mockModule.persistPublishedSourceManifestSnapshot(...args),
	loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.loadPublishedSourceSnapshot(...args),
	persistPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.persistPublishedSourceSnapshot(...args),
}))

const {
	loadPublishedEntityManifest,
	loadPublishedEntitySource,
} = await import('./published-source.ts')

function createSourceRow() {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	}
}

test('loadPublishedEntityManifest reads only manifest content from stored snapshots', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.readMockArtifactSnapshot.mockReset()
	mockModule.loadPublishedSourceManifestSnapshot.mockReset()
	mockModule.persistPublishedSourceManifestSnapshot.mockReset()
	mockModule.loadPublishedSourceSnapshot.mockReset()
	mockModule.persistPublishedSourceSnapshot.mockReset()

	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		manifestContent: JSON.stringify({
			name: '@kentcdodds/example-package',
			exports: {
				'.': './index.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		}),
		createdAt: '2026-04-20T00:00:00.000Z',
	})

	const manifest = await loadPublishedEntityManifest({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as Env,
		userId: 'user-1',
		sourceId: 'source-1',
	})

	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(1)
	expect(mockModule.readMockArtifactSnapshot).not.toHaveBeenCalled()
	expect(
		mockModule.persistPublishedSourceManifestSnapshot,
	).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(manifest).toMatchObject({
		source: expect.objectContaining({
			id: 'source-1',
		}),
		manifest: expect.objectContaining({
			name: '@kentcdodds/example-package',
			kody: expect.objectContaining({
				id: 'example-package',
			}),
		}),
	})
})

test('loadPublishedEntitySource persists fetched snapshots for later reuse', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.readMockArtifactSnapshot.mockReset()
	mockModule.loadPublishedSourceManifestSnapshot.mockReset()
	mockModule.persistPublishedSourceManifestSnapshot.mockReset()
	mockModule.loadPublishedSourceSnapshot.mockReset()
	mockModule.persistPublishedSourceSnapshot.mockReset()

	mockModule.getEntitySourceById.mockResolvedValue(createSourceRow())
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readMockArtifactSnapshot.mockResolvedValue({
		published_commit: 'commit-1',
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'.': './index.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'index.js': 'export const value = "ok"',
		},
	})
	mockModule.persistPublishedSourceSnapshot.mockResolvedValue(undefined)

	const source = await loadPublishedEntitySource({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as Env,
		userId: 'user-1',
		sourceId: 'source-1',
	})

	expect(mockModule.readMockArtifactSnapshot).toHaveBeenCalledTimes(1)
	expect(mockModule.persistPublishedSourceSnapshot).toHaveBeenCalledWith({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		},
		userId: 'user-1',
		source: expect.objectContaining({
			id: 'source-1',
		}),
		snapshot: expect.objectContaining({
			files: expect.objectContaining({
				'package.json': expect.any(String),
			}),
		}),
	})
	expect(source.files).toMatchObject({
		'index.js': 'export const value = "ok"',
	})
})
