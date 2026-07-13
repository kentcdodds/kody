import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactRepo from '#worker/repo/published-bundle-artifacts-repo.ts'
import type * as PublishedRuntimeArtifacts from './published-runtime-artifacts.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	rebuildPublishedPackageArtifacts,
} from './published-bundle-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	getPublishedBundleArtifactByIdentity: vi.fn(),
	insertPublishedBundleArtifactRow: vi.fn(),
	readPublishedBundleArtifact: vi.fn(),
	updatePublishedBundleArtifactRow: vi.fn(),
	writePublishedBundleArtifact: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-bundle-artifacts-repo.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactRepo>(
		'#worker/repo/published-bundle-artifacts-repo.ts',
	)
	return {
		...actual,
		getPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.getPublishedBundleArtifactByIdentity(...args),
		insertPublishedBundleArtifactRow: (...args: Array<unknown>) =>
			mockModule.insertPublishedBundleArtifactRow(...args),
		updatePublishedBundleArtifactRow: (...args: Array<unknown>) =>
			mockModule.updatePublishedBundleArtifactRow(...args),
	}
})

vi.mock('./published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedRuntimeArtifacts>(
		'./published-runtime-artifacts.ts',
	)
	return {
		...actual,
		readPublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.readPublishedBundleArtifact(...args),
		writePublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.writePublishedBundleArtifact(...args),
	}
})

test('loadPublishedBundleArtifactByIdentity treats mismatched and malformed KV artifact payloads as cache misses', async () => {
	mockModule.getPublishedBundleArtifactByIdentity.mockReset()
	mockModule.readPublishedBundleArtifact.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue({
		id: 'artifact-row-1',
		userId: 'user-1',
		sourceId: 'source-email-received-subscriber',
		publishedCommit: 'commit-email-received-subscriber',
		artifactKind: 'importable-module',
		artifactName: './workflow-approved-email',
		entryPoint: 'src/workflow-approved-email.ts',
		kvKey: 'kv:workflow-approved-email',
		dependenciesJson: '[]',
		createdAt: '2026-05-13T00:00:00.000Z',
		updatedAt: '2026-05-13T00:00:00.000Z',
	})
	mockModule.readPublishedBundleArtifact
		.mockResolvedValueOnce({
			version: 1,
			kind: 'importable-module',
			artifactName: '.',
			sourceId: 'source-ai-chat',
			publishedCommit: 'commit-ai-chat',
			entryPoint: 'src/index.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js':
					'export default async function runAgentTurn() { throw new Error("messages must include at least one message.") }',
			},
			dependencies: [],
			dynamicDependencies: [],
			packageContext: {
				packageId: 'pkg-ai-chat',
				kodyId: 'ai-chat',
				sourceId: 'source-ai-chat',
			},
			serviceContext: null,
			createdAt: '2026-05-13T00:00:00.000Z',
		})
		.mockResolvedValueOnce({
			version: 1,
			kind: 'importable-module',
			artifactName: './workflow-approved-email',
			sourceId: 'source-email-received-subscriber',
			publishedCommit: 'commit-email-received-subscriber',
			entryPoint: '',
			mainModule: 'dist/workflow-approved-email.js',
			modules: {
				'dist/workflow-approved-email.js':
					'export default async function run() { return "ok" }',
			},
			dependencies: [],
			dynamicDependencies: [],
			packageContext: {
				packageId: 'pkg-email-received-subscriber',
				kodyId: 'email-received-subscriber',
				sourceId: 'source-email-received-subscriber',
			},
			serviceContext: null,
			createdAt: '2026-05-13T00:00:00.000Z',
		})

	const mismatched = await loadPublishedBundleArtifactByIdentity({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env,
		userId: 'user-1',
		sourceId: 'source-email-received-subscriber',
		kind: 'importable-module',
		artifactName: './workflow-approved-email',
		entryPoint: './src/workflow-approved-email.ts',
	})
	const malformed = await loadPublishedBundleArtifactByIdentity({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env,
		userId: 'user-1',
		sourceId: 'source-email-received-subscriber',
		kind: 'importable-module',
		artifactName: './workflow-approved-email',
		entryPoint: './src/workflow-approved-email.ts',
	})

	for (const result of [mismatched, malformed]) {
		expect(result).toEqual({
			row: expect.objectContaining({
				sourceId: 'source-email-received-subscriber',
				artifactName: './workflow-approved-email',
				entryPoint: 'src/workflow-approved-email.ts',
			}),
			artifact: null,
		})
	}
})

test('rebuildPublishedPackageArtifacts bundles declared subscription handlers', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockReset()
	mockModule.insertPublishedBundleArtifactRow.mockReset()
	mockModule.readPublishedBundleArtifact.mockReset()
	mockModule.updatePublishedBundleArtifactRow.mockReset()
	mockModule.writePublishedBundleArtifact.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:key')
	mockModule.insertPublishedBundleArtifactRow.mockResolvedValue(undefined)

	const buildAppBundle = vi.fn()
	const buildModuleBundle = vi.fn(
		async ({ entryPoint }: { entryPoint: string }) => ({
			mainModule: `dist/${entryPoint.replaceAll('/', '_')}.js`,
			modules: {
				[`dist/${entryPoint.replaceAll('/', '_')}.js`]:
					'export default async function run() { return "ok" }',
			},
			dependencies: [],
		}),
	)
	const buildImportableModuleBundle = vi.fn(
		async ({ entryPoint }: { entryPoint: string }) => ({
			mainModule: `dist/importable_${entryPoint.replaceAll('/', '_')}.js`,
			modules: {
				[`dist/importable_${entryPoint.replaceAll('/', '_')}.js`]:
					'export default async function run(input) { return input }',
			},
			dependencies: [],
		}),
	)

	await rebuildPublishedPackageArtifacts({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {
				get: async () => null,
				put: async () => undefined,
				delete: async () => undefined,
			},
		} as unknown as Env,
		userId: 'user-1',
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-30T00:00:00.000Z',
			updated_at: '2026-04-30T00:00:00.000Z',
		},
		savedPackage: {
			id: 'pkg-1',
			userId: 'user-1',
			name: '@kentcdodds/email-automation',
			kodyId: 'email-automation',
			description: 'Email automation package',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			createdAt: '2026-04-30T00:00:00.000Z',
			updatedAt: '2026-04-30T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/email-automation',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'email-automation',
				description: 'Email automation package',
				subscriptions: {
					'email.message.received': {
						handler: './src/on-email-received.ts',
					},
					'email.message.quarantined': {
						handler: './src/on-email-quarantined.ts',
					},
				},
			},
		},
		buildAppBundle,
		buildModuleBundle,
		buildImportableModuleBundle,
	})

	expect(buildAppBundle).not.toHaveBeenCalled()
	expect(buildModuleBundle).toHaveBeenCalledWith({
		entryPoint: 'src/index.ts',
	})
	expect(buildImportableModuleBundle).toHaveBeenCalledWith({
		entryPoint: 'src/index.ts',
	})
	expect(buildModuleBundle).toHaveBeenCalledWith({
		entryPoint: 'src/on-email-received.ts',
	})
	expect(buildModuleBundle).toHaveBeenCalledWith({
		entryPoint: 'src/on-email-quarantined.ts',
	})
	expect(buildImportableModuleBundle).toHaveBeenCalledTimes(1)
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledTimes(4)
	expect(
		mockModule.insertPublishedBundleArtifactRow.mock.calls.map((call) => [
			call[1].artifactKind,
			call[1].artifactName,
		]),
	).toEqual([
		['module', '.'],
		['importable-module', '.'],
		['module', 'subscription:email.message.quarantined'],
		['module', 'subscription:email.message.received'],
	])
})

test('rebuildPublishedPackageArtifacts stores app bundles with artifactName null', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockReset()
	mockModule.insertPublishedBundleArtifactRow.mockReset()
	mockModule.updatePublishedBundleArtifactRow.mockReset()
	mockModule.writePublishedBundleArtifact.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:app')
	mockModule.insertPublishedBundleArtifactRow.mockResolvedValue(undefined)

	const buildAppBundle = vi.fn(async () => ({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { async fetch() { return new Response("ok") } }',
		},
		dependencies: [],
	}))
	const buildModuleBundle = vi.fn()
	const buildImportableModuleBundle = vi.fn()

	await rebuildPublishedPackageArtifacts({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {
				get: async () => null,
				put: async () => undefined,
				delete: async () => undefined,
			},
		} as unknown as Env,
		userId: 'user-1',
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-30T00:00:00.000Z',
			updated_at: '2026-04-30T00:00:00.000Z',
		},
		savedPackage: {
			id: 'pkg-1',
			userId: 'user-1',
			name: '@kentcdodds/example-app',
			kodyId: 'example-app',
			description: 'Example app package',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: true,
			hidden: false,
			createdAt: '2026-04-30T00:00:00.000Z',
			updatedAt: '2026-04-30T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/example-app',
			exports: {},
			kody: {
				id: 'example-app',
				description: 'Example app package',
				app: {
					entry: 'app.js',
				},
			},
		},
		buildAppBundle,
		buildModuleBundle,
		buildImportableModuleBundle,
	})

	expect(buildAppBundle).toHaveBeenCalledWith({
		entryPoint: 'app.js',
	})
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledTimes(1)
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			artifactKind: 'app',
			artifactName: null,
			entryPoint: 'app.js',
		}),
	)
	expect(mockModule.writePublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			kvKey: 'bundle-artifact:v1:source-1:commit-1:app:_:app.js',
		}),
	)
})

test('rebuildPublishedPackageArtifacts uses builder dependency metadata instead of package-wide fallback scans', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockReset()
	mockModule.insertPublishedBundleArtifactRow.mockReset()
	mockModule.updatePublishedBundleArtifactRow.mockReset()
	mockModule.writePublishedBundleArtifact.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:key')
	mockModule.insertPublishedBundleArtifactRow.mockResolvedValue(undefined)

	const buildAppBundle = vi.fn()
	const buildModuleBundle = vi.fn(async () => ({
		mainModule: 'dist/index.js',
		modules: {
			'dist/index.js': 'export default async function run() { return "ok" }',
		},
		dependencies: [],
	}))
	const buildImportableModuleBundle = vi.fn(async () => ({
		mainModule: 'dist/importable-index.js',
		modules: {
			'dist/importable-index.js': 'export const ready = true',
		},
		dependencies: [],
	}))

	await rebuildPublishedPackageArtifacts({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {
				get: async () => null,
				put: async () => undefined,
				delete: async () => undefined,
			},
		} as unknown as Env,
		userId: 'user-1',
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-30T00:00:00.000Z',
			updated_at: '2026-04-30T00:00:00.000Z',
		},
		savedPackage: {
			id: 'pkg-1',
			userId: 'user-1',
			name: '@kentcdodds/reachable-only',
			kodyId: 'reachable-only',
			description: 'Reachable-only dependency package',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			createdAt: '2026-04-30T00:00:00.000Z',
			updatedAt: '2026-04-30T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/reachable-only',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'reachable-only',
				description: 'Reachable-only dependency package',
			},
		},
		buildAppBundle,
		buildModuleBundle,
		buildImportableModuleBundle,
	})

	expect(mockModule.getEntitySourceById).not.toHaveBeenCalled()
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledTimes(2)
	expect(
		mockModule.insertPublishedBundleArtifactRow.mock.calls.map(
			(call) => call[1].dependenciesJson,
		),
	).toEqual(['[]', '[]'])
})
