import {
	countStaticDependentBundleArtifactPackages,
	listStaticDependentBundleArtifactRows,
	type StaticDependentBundleArtifactRow,
} from '#worker/repo/published-bundle-artifacts-repo.ts'

export const defaultStaticDependentPackageLimit = 10
const defaultStaticDependentArtifactsPerPackageLimit = 5

/**
 * One saved package whose published bundle artifacts statically captured another
 * saved package through a `kody:@scope/package` import.
 */
export type StaticDependentPackageSummaryItem = {
	package_id: string
	kody_id: string
	name: string
	source_id: string
	published_commit: string | null
	stale: boolean
	artifact_count: number
	entrypoints: Array<string>
	entrypoints_truncated: boolean
	bundled_dependency_commit: string | null
	current_dependency_commit: string
	recommended_action: string
}

/**
 * Bounded publish-result summary of direct static dependents. Kody exposes this
 * so agents can decide whether to inspect and republish dependent packages; it
 * deliberately does not fan out or republish anything automatically.
 */
export type StaticPackageDependentsSummary = {
	total: number
	stale: number
	truncated: boolean
	items: Array<StaticDependentPackageSummaryItem>
	recommended_next_action: string
}

type BuildStaticPackageDependentsSummaryInput = {
	total: number
	stale: number
	rows: Array<StaticDependentBundleArtifactRow>
	currentDependencyCommit: string
	packageLimit?: number
	artifactsPerPackageLimit?: number
}

type StaticDependentPackageAccumulator = {
	package_id: string
	kody_id: string
	name: string
	source_id: string
	published_commit: string | null
	matchingArtifactCount: number
	artifactRows: Array<StaticDependentBundleArtifactRow>
	entrypoints: Array<string>
	bundledDependencyCommits: Set<string>
	stale: boolean
}

function createRecommendedNextAction(input: { total: number; stale: number }) {
	if (input.total === 0) {
		return 'No published bundle artifacts currently declare a static dependency on this package.'
	}
	if (input.stale === 0) {
		return 'Static dependents already reference the current published dependency commit; dependent republish is not indicated by bundle metadata.'
	}
	return 'Inspect stale static dependents and republish only the packages whose bundled snapshot should include this package publish. Kody does not republish dependents automatically.'
}

function createRecommendedItemAction(input: { stale: boolean }) {
	if (!input.stale) {
		return 'No action indicated by bundle metadata; this dependent already references the current dependency commit.'
	}
	return 'Inspect this dependent package and republish it if its bundled static kody:@ snapshot should include the newly published dependency commit.'
}

function createAccumulator(
	row: StaticDependentBundleArtifactRow,
): StaticDependentPackageAccumulator {
	return {
		package_id: row.packageId,
		kody_id: row.packageKodyId,
		name: row.packageName,
		source_id: row.sourceId,
		published_commit: row.publishedCommit,
		matchingArtifactCount: row.matchingArtifactCount,
		artifactRows: [],
		entrypoints: [],
		bundledDependencyCommits: new Set(),
		stale: false,
	}
}

function addRowToAccumulator(input: {
	accumulator: StaticDependentPackageAccumulator
	row: StaticDependentBundleArtifactRow
	currentDependencyCommit: string
}) {
	input.accumulator.artifactRows.push(input.row)
	input.accumulator.matchingArtifactCount = Math.max(
		input.accumulator.matchingArtifactCount,
		input.row.matchingArtifactCount,
	)
	if (!input.accumulator.entrypoints.includes(input.row.entryPoint)) {
		input.accumulator.entrypoints.push(input.row.entryPoint)
	}
	if (input.row.bundledDependencyCommit) {
		input.accumulator.bundledDependencyCommits.add(
			input.row.bundledDependencyCommit,
		)
	}
	if (input.row.bundledDependencyCommit !== input.currentDependencyCommit) {
		input.accumulator.stale = true
	}
}

export function buildStaticPackageDependentsSummary(
	input: BuildStaticPackageDependentsSummaryInput,
): StaticPackageDependentsSummary {
	const packageLimit = input.packageLimit ?? defaultStaticDependentPackageLimit
	const artifactsPerPackageLimit =
		input.artifactsPerPackageLimit ??
		defaultStaticDependentArtifactsPerPackageLimit
	const packages = new Map<string, StaticDependentPackageAccumulator>()
	for (const row of input.rows) {
		const accumulator = packages.get(row.packageId) ?? createAccumulator(row)
		packages.set(row.packageId, accumulator)
		addRowToAccumulator({
			accumulator,
			row,
			currentDependencyCommit: input.currentDependencyCommit,
		})
	}
	const items = [...packages.values()].slice(0, packageLimit).map((item) => {
		const bundledCommits = [...item.bundledDependencyCommits]
		return {
			package_id: item.package_id,
			kody_id: item.kody_id,
			name: item.name,
			source_id: item.source_id,
			published_commit: item.published_commit,
			stale: item.stale,
			artifact_count: item.matchingArtifactCount,
			entrypoints: item.entrypoints.slice(0, artifactsPerPackageLimit),
			entrypoints_truncated:
				item.matchingArtifactCount >
				Math.min(item.entrypoints.length, artifactsPerPackageLimit),
			bundled_dependency_commit:
				bundledCommits.length === 1 ? (bundledCommits[0] ?? null) : null,
			current_dependency_commit: input.currentDependencyCommit,
			recommended_action: createRecommendedItemAction({ stale: item.stale }),
		} satisfies StaticDependentPackageSummaryItem
	})
	return {
		total: input.total,
		stale: input.stale,
		truncated: input.total > items.length,
		items,
		recommended_next_action: createRecommendedNextAction({
			total: input.total,
			stale: input.stale,
		}),
	}
}

export async function getStaticPackageDependentsSummary(input: {
	db: D1Database
	userId: string
	sourceId: string
	currentDependencyCommit: string
	packageLimit?: number
	artifactsPerPackageLimit?: number
}): Promise<StaticPackageDependentsSummary> {
	const packageLimit = input.packageLimit ?? defaultStaticDependentPackageLimit
	const artifactsPerPackageLimit =
		input.artifactsPerPackageLimit ??
		defaultStaticDependentArtifactsPerPackageLimit
	const [counts, rows] = await Promise.all([
		countStaticDependentBundleArtifactPackages(input.db, {
			userId: input.userId,
			sourceId: input.sourceId,
			currentDependencyCommit: input.currentDependencyCommit,
		}),
		listStaticDependentBundleArtifactRows(input.db, {
			userId: input.userId,
			sourceId: input.sourceId,
			currentDependencyCommit: input.currentDependencyCommit,
			packageLimit,
			artifactsPerPackageLimit,
		}),
	])
	return buildStaticPackageDependentsSummary({
		total: counts.totalPackages,
		stale: counts.stalePackages,
		rows,
		currentDependencyCommit: input.currentDependencyCommit,
		packageLimit,
		artifactsPerPackageLimit,
	})
}
