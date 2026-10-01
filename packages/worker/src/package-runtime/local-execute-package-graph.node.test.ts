import { expect, test, vi, beforeEach } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createSavedPackageRecord,
} from '#worker/test-support/module-graph.ts'
import {
	buildLocalExecutePackageGraph,
	type LocalExecutePackageGraphError,
} from './local-execute-package-graph.ts'

vi.mock('#worker/package-registry/scope-grants.ts', () => ({
	getPlatformAccountByUsername: mockModule.getPlatformAccountByUsername,
	isPlatformAccountStableUserId: async () => false,
	listPlatformAccountUsernames: async () => [],
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}
})

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
})

const graphInput = {
	env: { APP_DB: {}, REPO_SESSION: {} } as Env,
	baseUrl: 'https://heykody.dev',
	userId: 'user-1',
}

const examplePackage = {
	name: '@kentcdodds/example-package',
	kodyId: 'example-package',
}

function manifestJson(input: {
	name: string
	kodyId: string
	exports: Record<string, string>
}) {
	return JSON.stringify({
		name: input.name,
		exports: input.exports,
		kody: { id: input.kodyId, description: 'Example package' },
	})
}

function makeLoadedSource(input: {
	exports: Record<string, string>
	files: Record<string, string>
	publishedCommit?: string | null
}) {
	return {
		source: {
			id: 'source-1',
			published_commit: input.publishedCommit ?? 'commit-1',
		},
		manifest: {
			name: examplePackage.name,
			exports: input.exports,
			kody: { id: examplePackage.kodyId, description: 'Example package' },
		},
		files: {
			'package.json': manifestJson({
				...examplePackage,
				exports: input.exports,
			}),
			...input.files,
		},
	}
}

function makeArtifactHit(input: {
	artifactName: string
	entryPoint: string
	mainModule: string
	modules: Record<string, string>
}) {
	return {
		row: { id: `artifact-${input.artifactName}` },
		artifact: {
			version: 1,
			kind: 'importable-module' as const,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: input.modules,
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: examplePackage.kodyId,
				sourceId: 'source-1',
			},
			createdAt: '2026-05-01T00:00:00.000Z',
		},
	}
}

test('buildLocalExecutePackageGraph returns embeddable kody:@ modules from published artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './hello',
			entryPoint: 'src/hello.ts',
			mainModule: 'dist/hello.js',
			modules: {
				'dist/hello.js':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)

	const code = `import { greet } from 'kody:@kentcdodds/example-package/hello'
export default async function main(params) { return greet(params.name) }`
	const graph = await buildLocalExecutePackageGraph({ ...graphInput, code })

	expect(graph.imports).toEqual(['kody:@kentcdodds/example-package/hello'])
	expect(graph.warnings).toEqual([])
	const entry = graph.modules.find(
		(module) => module.name === 'kody:@kentcdodds/example-package/hello',
	)
	expect(entry).toBeDefined()
	expect(entry?.esModule).toMatch(/from ["']\.\.?\/.*\.__published_bundle__\//)
	expect(entry?.esModule).toContain('dist/hello.js')
	expect(entry?.esModule).not.toMatch(/from ["']\.__kody_packages__\//)
	expect(
		graph.modules.some(
			(module) =>
				module.name.includes('.__published_bundle__/') &&
				module.name.endsWith('/dist/hello.js'),
		),
	).toBe(true)
	expect(
		graph.modules.some(
			(module) => module.name === '.__kody_virtual__/runtime.js',
		),
	).toBe(true)
	expect(
		graph.modules.find(
			(module) => module.name === '.__kody_virtual__/runtime.js',
		)?.esModule,
	).toContain('kody:runtime')
	expect(
		graph.modules.some((module) => module.name.startsWith('.__kody_root__/')),
	).toBe(false)
})

test('buildLocalExecutePackageGraph rejects literal dynamic kody:@ imports', async () => {
	const code = `const m = await import('kody:@kentcdodds/example-package/hello')
export default async () => m`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'unsupported_dynamic_package_import',
	} satisfies Partial<LocalExecutePackageGraphError>)
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
})

test('buildLocalExecutePackageGraph rejects unresolved packages', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
	const code = `import x from 'kody:@missing/pkg/export'
export default async () => x`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unresolved',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph rejects unpublished packages without artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
			publishedCommit: null,
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph rejects missing published artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph returns an empty graph when there are no kody:@ imports', async () => {
	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: 'export default async function main() { return 1 }',
	})
	expect(graph).toEqual({ modules: [], imports: [], warnings: [] })
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
})
