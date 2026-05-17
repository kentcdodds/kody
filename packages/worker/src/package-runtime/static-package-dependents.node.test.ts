import { expect, test } from 'vitest'
import { buildStaticPackageDependentsSummary } from './static-package-dependents.ts'

test('buildStaticPackageDependentsSummary marks a static dependent stale after dependency republish', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 1,
		stale: 1,
		currentDependencyCommit: 'commit-a-new',
		rows: [
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: true,
				matchingArtifactCount: 1,
				matchingEntrypointCount: 1,
				packageBundledDependencyCommit: 'commit-a-old',
				bundledDependencyCommit: 'commit-a-old',
			},
		],
	})

	expect(summary).toEqual({
		total: 1,
		stale: 1,
		truncated: false,
		items: [
			{
				package_id: 'package-b',
				kody_id: 'package-b',
				name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				stale: true,
				artifact_count: 1,
				entrypoints: ['src/index.ts'],
				entrypoints_truncated: false,
				bundled_dependency_commit: 'commit-a-old',
				current_dependency_commit: 'commit-a-new',
				recommended_action:
					'Inspect this dependent package and republish it if its bundled static kody:@ snapshot should include the newly published dependency commit.',
			},
		],
		recommended_next_action:
			'Inspect stale static dependents and republish only the packages whose bundled snapshot should include this package publish. Kody does not republish dependents automatically.',
	})
})

test('buildStaticPackageDependentsSummary returns an empty summary with no dependents', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 0,
		stale: 0,
		currentDependencyCommit: 'commit-a',
		rows: [],
	})

	expect(summary).toEqual({
		total: 0,
		stale: 0,
		truncated: false,
		items: [],
		recommended_next_action:
			'No published bundle artifacts declare a static dependency on this package.',
	})
})

test('buildStaticPackageDependentsSummary bounds returned dependents and entrypoints', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 2,
		stale: 2,
		currentDependencyCommit: 'commit-a-new',
		packageLimit: 1,
		artifactsPerPackageLimit: 1,
		rows: [
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: true,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 2,
				packageBundledDependencyCommit: 'commit-a-old',
				bundledDependencyCommit: 'commit-a-old',
			},
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'job',
				artifactName: 'nightly',
				entryPoint: 'src/nightly.ts',
				packageStale: true,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 2,
				packageBundledDependencyCommit: 'commit-a-old',
				bundledDependencyCommit: 'commit-a-old',
			},
			{
				packageId: 'package-c',
				packageKodyId: 'package-c',
				packageName: '@kentcdodds/package-c',
				sourceId: 'source-c',
				publishedCommit: 'commit-c',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: true,
				matchingArtifactCount: 1,
				matchingEntrypointCount: 1,
				packageBundledDependencyCommit: 'commit-a-old',
				bundledDependencyCommit: 'commit-a-old',
			},
		],
	})

	expect(summary.truncated).toBe(true)
	expect(summary.items).toHaveLength(1)
	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			package_id: 'package-b',
			artifact_count: 2,
			entrypoints: ['src/index.ts'],
			entrypoints_truncated: true,
		}),
	)
})

test('buildStaticPackageDependentsSummary keeps stale true when stale artifact is not returned', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 1,
		stale: 1,
		currentDependencyCommit: 'commit-a-new',
		artifactsPerPackageLimit: 1,
		rows: [
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: true,
				matchingArtifactCount: 6,
				matchingEntrypointCount: 6,
				packageBundledDependencyCommit: null,
				bundledDependencyCommit: 'commit-a-new',
			},
		],
	})

	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			stale: true,
			artifact_count: 6,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)
})

test('buildStaticPackageDependentsSummary reports null commit for mixed missing dependency commits', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 1,
		stale: 1,
		currentDependencyCommit: 'commit-a-new',
		rows: [
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: true,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 2,
				packageBundledDependencyCommit: null,
				bundledDependencyCommit: 'commit-a-new',
			},
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'job',
				artifactName: 'nightly',
				entryPoint: 'src/nightly.ts',
				packageStale: true,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 2,
				packageBundledDependencyCommit: null,
				bundledDependencyCommit: null,
			},
		],
	})

	expect(summary.items[0]?.bundled_dependency_commit).toBeNull()
})

test('buildStaticPackageDependentsSummary truncates by distinct entrypoints, not artifact rows', () => {
	const summary = buildStaticPackageDependentsSummary({
		total: 1,
		stale: 0,
		currentDependencyCommit: 'commit-a-new',
		artifactsPerPackageLimit: 1,
		rows: [
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: false,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 1,
				packageBundledDependencyCommit: 'commit-a-new',
				bundledDependencyCommit: 'commit-a-new',
			},
			{
				packageId: 'package-b',
				packageKodyId: 'package-b',
				packageName: '@kentcdodds/package-b',
				sourceId: 'source-b',
				publishedCommit: 'commit-b',
				artifactKind: 'importable-module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				packageStale: false,
				matchingArtifactCount: 2,
				matchingEntrypointCount: 1,
				packageBundledDependencyCommit: 'commit-a-new',
				bundledDependencyCommit: 'commit-a-new',
			},
		],
	})

	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			artifact_count: 2,
			entrypoints: ['src/index.ts'],
			entrypoints_truncated: false,
		}),
	)
})
