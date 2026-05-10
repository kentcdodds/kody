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
				matchingArtifactCount: 1,
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
			'No published bundle artifacts currently declare a static dependency on this package.',
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
				matchingArtifactCount: 2,
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
				matchingArtifactCount: 2,
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
				matchingArtifactCount: 1,
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
