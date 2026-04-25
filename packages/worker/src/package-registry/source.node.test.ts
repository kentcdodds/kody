import { expect, test, vi } from 'vitest'

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

const { loadPackageSourceBySourceId, loadPackageManifestBySourceId } =
	await import('./source.ts')

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

test('loadPackageSourceBySourceId reuses cached published package sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-1',
			publishedCommit: 'commit-1',
		}),
	)
	mockModule.loadPublishedEntitySource.mockResolvedValue({
		source: createPackageSourceRow({
			id: 'source-published-1',
			publishedCommit: 'commit-1',
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
	})

	const first = await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-1',
	})
	const second = await loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-1',
	})

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(first).toStrictEqual(second)
	expect(Object.isFrozen(first)).toBe(true)
	expect(Object.isFrozen(first.source)).toBe(true)
	expect(Object.isFrozen(first.manifest)).toBe(true)
	expect(Object.isFrozen(first.files)).toBe(true)
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

test('loadPackageManifestBySourceId reads only the manifest for published sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntityManifest.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace

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

	const first = await loadPackageManifestBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-manifest-only-1',
	})
	const second = await loadPackageManifestBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-manifest-only-1',
	})

	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntitySource).not.toHaveBeenCalled()
	expect(first).toStrictEqual(second)
	expect(first.manifest).toMatchObject({
		name: '@kentcdodds/example-package',
		kody: {
			id: 'example-package',
		},
	})
})

test('loadPackageSourceBySourceId does not cache unpublished sources', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace

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
		loadPackageSourceBySourceId({
			env: {
				APP_DB: {},
				BUNDLE_ARTIFACTS_KV: bundleKv,
			} as Env,
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			sourceId: 'source-unpublished-1',
		}),
	).rejects.toThrow('Source "source-unpublished-1" has no published commit.')
	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
})

test('loadPackageSourceBySourceId shares the same in-flight published source load', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace

	type PublishedSourcePayload = {
		source: ReturnType<typeof createPackageSourceRow>
		files: Record<string, string>
	}
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

	const firstPromise = loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-concurrent',
	})
	const secondPromise = loadPackageSourceBySourceId({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-concurrent',
	})

	resolveFiles?.({
		source: createPackageSourceRow({
			id: 'source-published-concurrent',
			publishedCommit: 'commit-concurrent-1',
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
	})

	const [first, second] = await Promise.all([firstPromise, secondPromise])

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
})

test('loadPackageSourceBySourceId evicts failed published source loads before retrying', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.loadPublishedEntitySource.mockReset()
	const bundleKv = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	} as unknown as KVNamespace

	mockModule.getEntitySourceById.mockResolvedValue(
		createPackageSourceRow({
			id: 'source-published-failure',
			publishedCommit: 'commit-failure-1',
		}),
	)
	mockModule.loadPublishedEntitySource
		.mockRejectedValueOnce(new Error('repo load failed'))
		.mockResolvedValueOnce({
			source: createPackageSourceRow({
				id: 'source-published-failure',
				publishedCommit: 'commit-failure-1',
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
		})

	const input = {
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-published-failure',
	}

	await expect(loadPackageSourceBySourceId(input)).rejects.toThrow(
		'repo load failed',
	)
	await expect(loadPackageSourceBySourceId(input)).resolves.toMatchObject({
		files: {
			'app.js':
				'export default { async fetch() { return new Response("ok") } }',
			'index.js': 'export const value = "ok"',
		},
	})

	expect(mockModule.loadPublishedEntitySource).toHaveBeenCalledTimes(2)
})
