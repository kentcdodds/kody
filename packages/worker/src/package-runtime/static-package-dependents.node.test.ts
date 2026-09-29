import { expect, test } from 'vitest'
import { buildStaticPackageDependentsSummary } from './static-package-dependents.ts'

type Input = Parameters<typeof buildStaticPackageDependentsSummary>[0]
type Row = Input['rows'][number]

function makeRow(overrides: Partial<Row> = {}): Row {
	const leaf = overrides.packageId ?? 'package-b'
	const suffix = leaf.replace('package-', '')
	return {
		packageId: leaf,
		packageKodyId: leaf,
		packageName: `@kentcdodds/${leaf}`,
		sourceId: `source-${suffix}`,
		publishedCommit: `commit-${suffix}`,
		artifactKind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
		packageStale: true,
		matchingArtifactCount: 1,
		matchingEntrypointCount: 1,
		packageBundledDependencyCommit: 'commit-a-old',
		bundledDependencyCommit: 'commit-a-old',
		...overrides,
	}
}

const nightlyJob = {
	artifactKind: 'job',
	artifactName: 'nightly',
	entryPoint: 'src/nightly.ts',
} as const

function summarize(rows: Array<Row>, extra: Partial<Input> = {}) {
	return buildStaticPackageDependentsSummary({
		total: 1,
		stale: 1,
		currentDependencyCommit: 'commit-a-new',
		rows,
		...extra,
	})
}

test('buildStaticPackageDependentsSummary reports stale state, limits, and aggregation', () => {
	expect(summarize([makeRow()])).toMatchObject({
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

	expect(
		summarize([], { total: 0, stale: 0, currentDependencyCommit: 'commit-a' }),
	).toMatchObject({ total: 0, stale: 0, truncated: false, items: [] })

	const twoArtifacts = { matchingArtifactCount: 2, matchingEntrypointCount: 2 }
	const boundedSummary = summarize(
		[
			makeRow(twoArtifacts),
			makeRow({ ...twoArtifacts, ...nightlyJob }),
			makeRow({ packageId: 'package-c' }),
		],
		{ total: 2, stale: 2, packageLimit: 1, artifactsPerPackageLimit: 1 },
	)
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

	const currentBundle = {
		packageBundledDependencyCommit: null,
		bundledDependencyCommit: 'commit-a-new',
	}
	const hiddenStaleSummary = summarize(
		[
			makeRow({
				...currentBundle,
				matchingArtifactCount: 6,
				matchingEntrypointCount: 6,
			}),
		],
		{ artifactsPerPackageLimit: 1 },
	)
	expect(hiddenStaleSummary.items[0]).toEqual(
		expect.objectContaining({
			stale: true,
			artifact_count: 6,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)

	const mixedCommitSummary = summarize([
		makeRow({ ...currentBundle, ...twoArtifacts }),
		makeRow({
			...twoArtifacts,
			...nightlyJob,
			packageBundledDependencyCommit: null,
			bundledDependencyCommit: null,
		}),
	])
	expect(mixedCommitSummary.items[0]?.bundled_dependency_commit).toBeNull()

	const freshRow = {
		packageStale: false,
		matchingArtifactCount: 2,
		matchingEntrypointCount: 1,
		packageBundledDependencyCommit: 'commit-a-new',
		bundledDependencyCommit: 'commit-a-new',
	}
	const entrypointSummary = summarize(
		[
			makeRow(freshRow),
			makeRow({ ...freshRow, artifactKind: 'importable-module' }),
		],
		{ stale: 0, artifactsPerPackageLimit: 1 },
	)
	expect(entrypointSummary.items[0]).toEqual(
		expect.objectContaining({
			artifact_count: 2,
			entrypoints: ['src/index.ts'],
			entrypoints_truncated: false,
		}),
	)
})
