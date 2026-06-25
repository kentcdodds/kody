import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
	buildPublishedBundleArtifactKvKey,
	deletePublishedBundleArtifact,
	hasPublishedRuntimeArtifacts,
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import {
	deletePublishedBundleArtifactRowsBySourceId,
	getPublishedBundleArtifactByIdentity,
	insertPublishedBundleArtifactRow,
	listPublishedBundleArtifactsBySourceId,
	type PublishedBundleArtifactRecord,
	type PublishedBundleArtifactUpsertInput,
	updatePublishedBundleArtifactRow,
} from '#worker/repo/published-bundle-artifacts-repo.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from './package-artifact-targets.ts'

type PersistPublishedBundleArtifactInput = {
	env: Env
	userId: string
	source: EntitySourceRow
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	packageContext?: PublishedBundleArtifact['packageContext']
}

type PublishedPackageArtifactBuilders = {
	buildAppBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
	buildModuleBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
	buildImportableModuleBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
}

function normalizeArtifactName(artifactName: string | null | undefined) {
	const trimmed = artifactName?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function normalizeEntryPoint(entryPoint: string) {
	const trimmed = entryPoint.trim().replace(/^\.?\//, '')
	if (!trimmed) {
		throw new Error('Bundle artifact entrypoint must be non-empty.')
	}
	return trimmed
}

function toDbRowInput(input: {
	userId: string
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependencies: Array<BundleArtifactDependency>
}): PublishedBundleArtifactUpsertInput {
	return {
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		artifactKind: input.kind,
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
		kvKey: input.kvKey,
		dependenciesJson: JSON.stringify(input.dependencies),
	}
}

function matchesPublishedBundleArtifactIdentity(input: {
	artifact: PublishedBundleArtifact
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
}) {
	let artifactEntryPoint: string
	try {
		artifactEntryPoint = normalizeEntryPoint(input.artifact.entryPoint)
	} catch {
		return false
	}
	return (
		input.artifact.sourceId === input.sourceId &&
		input.artifact.publishedCommit === input.publishedCommit &&
		input.artifact.kind === input.kind &&
		normalizeArtifactName(input.artifact.artifactName) === input.artifactName &&
		artifactEntryPoint === input.entryPoint &&
		input.artifact.modules[input.artifact.mainModule] != null
	)
}

export async function persistPublishedBundleArtifact(
	input: PersistPublishedBundleArtifactInput,
) {
	if (
		!input.source.published_commit ||
		!hasPublishedRuntimeArtifacts(input.env)
	) {
		return null
	}
	const artifactName = normalizeArtifactName(input.artifactName)
	const entryPoint = normalizeEntryPoint(input.entryPoint)
	const kvKey = buildPublishedBundleArtifactKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		kind: input.kind,
		artifactName,
		entryPoint,
	})
	const artifact: PublishedBundleArtifact = {
		version: 1,
		kind: input.kind,
		artifactName,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		entryPoint,
		mainModule: input.mainModule,
		modules: input.modules,
		dependencies: input.dependencies,
		dynamicDependencies: input.dynamicDependencies ?? [],
		packageContext: input.packageContext ?? null,
		serviceContext: null,
		createdAt: new Date().toISOString(),
	}
	const existing = await getPublishedBundleArtifactByIdentity(
		input.env.APP_DB,
		{
			userId: input.userId,
			sourceId: input.source.id,
			artifactKind: input.kind,
			artifactName,
			entryPoint,
		},
	)
	const rowInput = toDbRowInput({
		userId: input.userId,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		kind: input.kind,
		artifactName,
		entryPoint,
		kvKey,
		dependencies: input.dependencies,
	})
	try {
		await writePublishedBundleArtifact({
			env: input.env,
			artifact,
			kvKey,
		})
		if (existing) {
			await updatePublishedBundleArtifactRow(input.env.APP_DB, {
				id: existing.id,
				...rowInput,
			})
		} else {
			await insertPublishedBundleArtifactRow(input.env.APP_DB, rowInput)
		}
	} catch (error) {
		await deletePublishedBundleArtifact({
			env: input.env,
			kvKey,
		}).catch(() => {
			// Best effort; preserve the original DB/KV failure as the root cause.
		})
		throw error
	}
	return kvKey
}

export async function loadPublishedBundleArtifactByIdentity(input: {
	env: Env
	userId: string
	sourceId: string
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
}) {
	const artifactName = normalizeArtifactName(input.artifactName)
	const entryPoint = normalizeEntryPoint(input.entryPoint)
	const row = await getPublishedBundleArtifactByIdentity(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.sourceId,
		artifactKind: input.kind,
		artifactName,
		entryPoint,
	})
	if (!row) return null
	const artifact = await readPublishedBundleArtifact({
		env: input.env,
		kvKey: row.kvKey,
	})
	if (!artifact) {
		return {
			row,
			artifact: null,
		}
	}
	if (
		!matchesPublishedBundleArtifactIdentity({
			artifact,
			sourceId: row.sourceId,
			publishedCommit: row.publishedCommit,
			kind: input.kind,
			artifactName,
			entryPoint,
		})
	) {
		return {
			row,
			artifact: null,
		}
	}
	return {
		row,
		artifact,
	}
}

export async function persistPublishedPackageArtifactTarget(
	input: {
		env: Env
		userId: string
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		target: PublishedPackageArtifactBuildTarget
	} & PublishedPackageArtifactBuilders,
) {
	const bundle =
		input.target.bundleKind === 'app'
			? await input.buildAppBundle({ entryPoint: input.target.entryPoint })
			: input.target.bundleKind === 'importable-module'
				? await input.buildImportableModuleBundle({
						entryPoint: input.target.entryPoint,
					})
				: await input.buildModuleBundle({
						entryPoint: input.target.entryPoint,
					})
	return await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: input.source,
		kind: input.target.kind,
		artifactName: input.target.artifactName,
		entryPoint: input.target.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		dynamicDependencies: bundle.dynamicDependencies,
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
	})
}

export async function rebuildPublishedPackageArtifacts(
	input: {
		env: Env
		userId: string
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		manifest: AuthoredPackageJson
	} & PublishedPackageArtifactBuilders,
) {
	for (const target of collectPublishedPackageArtifactTargets(input.manifest)) {
		await persistPublishedPackageArtifactTarget({
			env: input.env,
			userId: input.userId,
			source: input.source,
			savedPackage: input.savedPackage,
			target,
			buildAppBundle: input.buildAppBundle,
			buildModuleBundle: input.buildModuleBundle,
			buildImportableModuleBundle: input.buildImportableModuleBundle,
		})
	}
}

export async function deletePublishedArtifactsForSource(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	const rows = await listPublishedBundleArtifactsBySourceId(
		input.env.APP_DB,
		input.userId,
		input.sourceId,
	)
	if (hasPublishedRuntimeArtifacts(input.env)) {
		await Promise.all(
			rows.map(async (row: PublishedBundleArtifactRecord) => {
				await deletePublishedBundleArtifact({
					env: input.env,
					kvKey: row.kvKey,
				})
			}),
		)
	}
	await deletePublishedBundleArtifactRowsBySourceId(
		input.env.APP_DB,
		input.userId,
		input.sourceId,
	)
}

export type { PublishedBundleArtifactRecord }
export { collectPublishedPackageArtifactTargets }
export type { PublishedPackageArtifactBuildTarget }
