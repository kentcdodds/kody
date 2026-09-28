import { expect, test } from 'vitest'
import {
	buildComputedPackageImportCallBundle,
	computedPackageImportCallEntryPath,
	resolveComputedPackageImportArtifact,
} from './computed-package-import.ts'
import { createSealedSecretProviderExportDeniedMessage } from '#mcp/secrets/secret-providers/errors.ts'

test('buildComputedPackageImportCallBundle wraps the importable main with a callable entry and grants the callee', () => {
	const bundle = buildComputedPackageImportCallBundle({
		specifier: 'kody:@kentcdodds/example/probe',
		artifact: {
			version: 1,
			kind: 'importable-module',
			artifactName: './probe',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/probe.ts',
			mainModule: '.__kody_root__/.__kody_import_entry__.js',
			modules: {
				'.__kody_root__/.__kody_import_entry__.js':
					'export default async function probe() { return 1 }',
			},
			dependencies: [],
			dynamicDependencies: [],
			packageContext: {
				packageId: 'pkg-callee',
				kodyId: 'example',
				sourceId: 'source-1',
			},
			createdAt: new Date().toISOString(),
		},
	})

	expect(bundle.mainModule).toBe(computedPackageImportCallEntryPath)
	expect(bundle.modules[computedPackageImportCallEntryPath]).toContain(
		'__kodyComputedImportCall',
	)
	expect(bundle.modules[computedPackageImportCallEntryPath]).toContain(
		'.__kody_root__/.__kody_import_entry__.js',
	)
	expect(bundle.dependencies).toEqual([
		expect.objectContaining({
			packageId: 'pkg-callee',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			platformOwned: false,
		}),
	])
})

test('resolveComputedPackageImportArtifact denies sealed ./secretProvider exports before source load', async () => {
	await expect(
		resolveComputedPackageImportArtifact({
			env: {} as Env,
			baseUrl: 'https://kody.dev',
			userId: 'user-1',
			specifier: 'kody:@kentcdodds/example/secretProvider',
		}),
	).rejects.toThrow(createSealedSecretProviderExportDeniedMessage())
})
