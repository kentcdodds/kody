import { expect, test, vi } from 'vitest'
import {
	countStaticDependentBundleArtifactPackages,
	listStaticDependentBundleArtifactRows,
} from './published-bundle-artifacts-repo.ts'

function createStaticDependentsDb(input: {
	first?: Record<string, unknown> | null
	results?: Array<Record<string, unknown>>
	onBind?: (query: string, values: Array<unknown>) => void
}) {
	return {
		prepare(query: string) {
			return {
				bind(...values: Array<unknown>) {
					input.onBind?.(query, values)
					return {
						async first() {
							return input.first ?? null
						},
						async all() {
							return { results: input.results ?? [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('countStaticDependentBundleArtifactPackages counts direct JSON dependency rows by source id', async () => {
	const onBind = vi.fn()
	const db = createStaticDependentsDb({
		first: {
			total_packages: 2,
			stale_packages: 1,
		},
		onBind,
	})

	const result = await countStaticDependentBundleArtifactPackages(db, {
		userId: 'user-1',
		sourceId: 'source-a',
		currentDependencyCommit: 'commit-a-new',
	})

	expect(result).toEqual({
		totalPackages: 2,
		stalePackages: 1,
	})
	expect(onBind).toHaveBeenCalledTimes(1)
	expect(onBind).toHaveBeenCalledWith(expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
	])
})

test('listStaticDependentBundleArtifactRows maps bounded dependent package artifact rows', async () => {
	const onBind = vi.fn()
	const db = createStaticDependentsDb({
		results: [
			{
				package_id: 'package-b',
				package_kody_id: 'package-b',
				package_name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				artifact_kind: 'module',
				artifact_name: '.',
				entry_point: 'src/index.ts',
				package_stale: 1,
				matching_artifact_count: 1,
				matching_entrypoint_count: 1,
				package_bundled_dependency_commit: 'commit-a-old',
				bundled_dependency_commit: 'commit-a-old',
			},
		],
		onBind,
	})

	const rows = await listStaticDependentBundleArtifactRows(db, {
		userId: 'user-1',
		sourceId: 'source-a',
		currentDependencyCommit: 'commit-a-new',
		packageLimit: 10,
		artifactsPerPackageLimit: 5,
	})

	expect(rows).toEqual([
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
	])
	expect(onBind).toHaveBeenCalledTimes(1)
	expect(onBind).toHaveBeenCalledWith(expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
		10,
		5,
	])
})
