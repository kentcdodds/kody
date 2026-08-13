import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LongRunningExportMessage,
} from '#worker/d1-retry.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	loadPublishedEntitySource: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntitySource(...args),
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
}))

const {
	loadPackageSourceBySourceId,
	loadPackageManifestBySourceId,
	loadPackageSourceFromFiles,
} = await import('./source.ts')

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

function createBundleKv() {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace
}

function createPublishedSourcePayload(sourceId: string, commit: string) {
	return {
		source: createPackageSourceRow({
			id: sourceId,
			publishedCommit: commit,
		}),
		files: {
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
			'app.js':
				'export default { async fetch() { return new Response("ok") } }',
			'index.js': 'export const value = "ok"',
		},
	}
}

function createLoadSourceInput(sourceId: string, bundleKv: KVNamespace) {
	return {
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId,
	}
}

test('loadPackageSourceBySourceId caches published sources, shares in-flight loads, evicts failures, and skips cache for unpublished sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = createBundleKv()

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-1',
			publishedCommit: 'commit-1',
		}),
	)
	mockModule.loadPublishedEntitySource.mockResolvedValue(
		createPublishedSourcePayload('source-published-1', 'commit-1'),
	)

	const cachedInput = createLoadSourceInput('source-published-1', bundleKv)
	const first = await loadPackageSourceBySourceId(cachedInput)
	const second = await loadPackageSourceBySourceId(cachedInput)

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(first).toStrictEqual(second)
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

	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const concurrentKv = createBundleKv()
	type PublishedSourcePayload = ReturnType<typeof createPublishedSourcePayload>
	let resolveFiles: ((value: PublishedSourcePayload) => void) | null = null
	const filesPromise = new Promise<PublishedSourcePayload>((resolve) => {
		resolveFiles = resolve
	})

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-concurrent',
			publishedCommit: 'commit-concurrent-1',
		}),
	)
	mockModule.loadPublishedEntitySource.mockImplementation(
		async () => await filesPromise,
	)

	const concurrentInput = createLoadSourceInput(
		'source-published-concurrent',
		concurrentKv,
	)
	const firstPromise = loadPackageSourceBySourceId(concurrentInput)
	const secondPromise = loadPackageSourceBySourceId(concurrentInput)

	resolveFiles?.(
		createPublishedSourcePayload(
			'source-published-concurrent',
			'commit-concurrent-1',
		),
	)

	const [concurrentFirst, concurrentSecond] = await Promise.all([
		firstPromise,
		secondPromise,
	])

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(concurrentFirst).toBe(concurrentSecond)

	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const failureKv = createBundleKv()

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-failure',
			publishedCommit: 'commit-failure-1',
		}),
	)
	mockModule.loadPublishedEntitySource
		.mockRejectedValueOnce(new Error('repo load failed'))
		.mockResolvedValueOnce(
			createPublishedSourcePayload(
				'source-published-failure',
				'commit-failure-1',
			),
		)

	const failureInput = createLoadSourceInput(
		'source-published-failure',
		failureKv,
	)

	await expect(loadPackageSourceBySourceId(failureInput)).rejects.toThrow(
		'repo load failed',
	)
	await expect(
		loadPackageSourceBySourceId(failureInput),
	).resolves.toMatchObject({
		files: {
			'app.js':
				'export default { async fetch() { return new Response("ok") } }',
			'index.js': 'export const value = "ok"',
		},
	})
	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(2)

	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const unpublishedKv = createBundleKv()

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-unpublished-1',
			publishedCommit: null,
		}),
	)
	mockModule.loadPublishedEntitySource.mockRejectedValue(
		new Error('Source "source-unpublished-1" has no published commit.'),
	)

	await expect(
		loadPackageSourceBySourceId(
			createLoadSourceInput('source-unpublished-1', unpublishedKv),
		),
	).rejects.toThrow('Source "source-unpublished-1" has no published commit.')
	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
})

test('loadPackageManifestBySourceId reads manifest-only sources with D1 retry, and loadPackageSourceFromFiles parses caller files with ownership checks', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntityManifest.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const manifestKv = createBundleKv()

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-manifest-only-1',
			publishedCommit: 'commit-manifest-only-1',
		}),
	)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: createPackageSourceRow({
			id: 'source-manifest-only-1',
			publishedCommit: 'commit-manifest-only-1',
		}),
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
		manifest: {
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
		},
	})

	const manifestInput = {
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: manifestKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-manifest-only-1',
	}
	const firstManifest = await loadPackageManifestBySourceId(manifestInput)
	const secondManifest = await loadPackageManifestBySourceId(manifestInput)

	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntitySource).not.toHaveBeenCalled()
	expect(firstManifest).toStrictEqual(secondManifest)
	expect(firstManifest.manifest).toMatchObject({
		name: '@kentcdodds/example-package',
		kody: {
			id: 'example-package',
		},
	})

	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntityManifest.mockReset()
	const retryKv = createBundleKv()
	const source = createPackageSourceRow({
		id: 'source-retry-export',
		publishedCommit: 'commit-retry-1',
	})
	const manifest = {
		name: '@kentcdodds/example-package',
		exports: { '.': './index.js' },
		kody: {
			id: 'example-package',
			description: 'Example package',
		},
	}
	mockModule.getEntitySourceById
		.mockRejectedValueOnce(
			new Error(`D1_ERROR: ${d1LongRunningExportMessage}.`),
		)
		.mockResolvedValueOnce(source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source,
		content: JSON.stringify(manifest),
		manifest,
	})

	vi.useFakeTimers()
	try {
		const resultPromise = loadPackageManifestBySourceId({
			env: {
				APP_DB: {},
				BUNDLE_ARTIFACTS_KV: retryKv,
			} as Env,
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			sourceId: 'source-retry-export',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toMatchObject({
			manifest: {
				name: '@kentcdodds/example-package',
				kody: { id: 'example-package' },
			},
		})
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)

	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-from-files',
			publishedCommit: 'commit-fork-1',
		}),
	)
	const files = {
		'package.json': JSON.stringify({
			name: '@kentcdodds/example-package',
			exports: { '.': './index.js' },
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		}),
		'index.js': 'export default async function main() { return "ok" }\n',
	}

	const loaded = await loadPackageSourceFromFiles({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		sourceId: 'source-from-files',
		files,
	})

	expect(loaded.files).toEqual(files)
	expect(loaded.manifest.kody.id).toBe('example-package')
	expect(mockModule.loadPublishedEntitySource).not.toHaveBeenCalled()

	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		...createPackageSourceRow({
			id: 'source-from-files',
			publishedCommit: 'commit-fork-1',
		}),
		user_id: 'user-2',
	})
	await expect(
		loadPackageSourceFromFiles({
			env: { APP_DB: {} } as Env,
			userId: 'user-1',
			sourceId: 'source-from-files',
			files: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/example-package',
					exports: { '.': './index.js' },
					kody: {
						id: 'example-package',
						description: 'Example package',
					},
				}),
			},
		}),
	).rejects.toThrow('was not found')
})
