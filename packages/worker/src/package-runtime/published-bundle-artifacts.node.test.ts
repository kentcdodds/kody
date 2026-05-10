import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactRepo from '#worker/repo/published-bundle-artifacts-repo.ts'
import type * as PublishedRuntimeArtifacts from './published-runtime-artifacts.ts'
import { rebuildPublishedPackageArtifacts } from './published-bundle-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	getPublishedBundleArtifactByIdentity: vi.fn(),
	insertPublishedBundleArtifactRow: vi.fn(),
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
		writePublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.writePublishedBundleArtifact(...args),
	}
})

test('rebuildPublishedPackageArtifacts bundles declared subscription handlers', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getPublishedBundleArtifactByIdentity.mockReset()
	mockModule.insertPublishedBundleArtifactRow.mockReset()
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
		files: {
			'package.json': '{}',
			'src/index.ts': 'export default async function run() { return "ok" }',
			'src/on-email-received.ts':
				'export default async function run() { return "received" }',
			'src/on-email-quarantined.ts':
				'export default async function run() { return "quarantined" }',
		},
		buildAppBundle,
		buildModuleBundle,
		buildImportableModuleBundle,
	})

	expect(buildAppBundle).not.toHaveBeenCalled()
	expect(buildModuleBundle).toHaveBeenCalledWith({
		entryPoint: './src/index.ts',
	})
	expect(buildImportableModuleBundle).toHaveBeenCalledWith({
		entryPoint: './src/index.ts',
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
		files: {
			'package.json': '{}',
			'src/index.ts': 'export default async function run() { return "ok" }',
			'src/dead.ts':
				'import dead from "kody:@kentcdodds/missing-package"; export { dead }',
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
