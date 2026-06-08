import { expect, test } from 'vitest'
import { buildStaticPackageDependentsSummary } from './static-package-dependents.ts'

test('buildStaticPackageDependentsSummary reports stale state, limits, and aggregation', () => {
	const staleSummary = buildStaticPackageDependentsSummary({
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

	expect(staleSummary).toMatchObject({
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
			},
		],
	})

	const emptySummary = buildStaticPackageDependentsSummary({
		total: 0,
		stale: 0,
		currentDependencyCommit: 'commit-a',
		rows: [],
	})
	expect(emptySummary).toMatchObject({
		total: 0,
		stale: 0,
		truncated: false,
		items: [],
	})

	const boundedSummary = buildStaticPackageDependentsSummary({
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
	expect(boundedSummary.truncated).toBe(true)
	expect(boundedSummary.items).toHaveLength(1)
	expect(boundedSummary.items[0]).toEqual(
		expect.objectContaining({
			package_id: 'package-b',
			artifact_count: 2,
			entrypoints: ['src/index.ts'],
			entrypoints_truncated: true,
		}),
	)

	const hiddenStaleSummary = buildStaticPackageDependentsSummary({
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
	expect(hiddenStaleSummary.items[0]).toEqual(
		expect.objectContaining({
			stale: true,
			artifact_count: 6,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)

	const mixedCommitSummary = buildStaticPackageDependentsSummary({
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
	expect(mixedCommitSummary.items[0]?.bundled_dependency_commit).toBeNull()

	const entrypointSummary = buildStaticPackageDependentsSummary({
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
	expect(entrypointSummary.items[0]).toEqual(
		expect.objectContaining({
			artifact_count: 2,
			entrypoints: ['src/index.ts'],
			entrypoints_truncated: false,
		}),
	)
})
