import { getPackageAppEntryPath } from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	type BundleArtifactDependency,
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
	parseKodyPackageSpecifier,
	resolveSavedPackageImport,
	packageSpecifierPrefix,
} from './package-import-resolution.ts'

type DependencyResolutionState = {
	env: Env
	userId: string
	visited: Set<string>
	dependencies: Array<BundleArtifactDependency>
}

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
	packageContext?: PublishedBundleArtifact['packageContext']
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

async function resolveDependencyForPackage(input: {
	state: DependencyResolutionState
	specifier: string
}) {
	const parsed = parseKodyPackageSpecifier(input.specifier)
	const existing = input.state.visited.has(parsed.packageName)
	if (existing) return
	input.state.visited.add(parsed.packageName)
	const row = await resolveSavedPackageImport({
		db: input.state.env.APP_DB,
		userId: input.state.userId,
		specifier: parsed,
	})
	if (!row) {
		throw new Error(`Saved package "${parsed.packageName}" was not found for this user.`)
	}
	const source = await getEntitySourceById(input.state.env.APP_DB, row.sourceId)
	if (!source?.published_commit) {
		throw new Error(
			`Saved package "${row.name}" source "${row.sourceId}" has no published commit.`,
		)
	}
	input.state.dependencies.push({
		sourceId: source.id,
		publishedCommit: source.published_commit,
		kodyId: row.kodyId,
	})
}

async function collectDependenciesFromFiles(input: {
	env: Env
	userId: string
	files: Record<string, string>
}) {
	const packageSpecifierPattern = /['"](kody:@[^'"]+)['"]/g
	const state: DependencyResolutionState = {
		env: input.env,
		userId: input.userId,
		visited: new Set(),
		dependencies: [],
	}
	for (const content of Object.values(input.files)) {
		for (const match of content.matchAll(packageSpecifierPattern)) {
			const specifier = match[1]?.trim()
			if (!specifier?.startsWith(packageSpecifierPrefix)) continue
			await resolveDependencyForPackage({
				state,
				specifier,
			})
		}
	}
	return state.dependencies.sort((left, right) =>
		left.kodyId.localeCompare(right.kodyId),
	)
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

export async function persistPublishedBundleArtifact(input: PersistPublishedBundleArtifactInput) {
	if (!input.source.published_commit || !hasPublishedRuntimeArtifacts(input.env)) {
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
		packageContext: input.packageContext ?? null,
		createdAt: new Date().toISOString(),
	}
	const existing = await getPublishedBundleArtifactByIdentity(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.source.id,
		artifactKind: input.kind,
		artifactName,
		entryPoint,
	})
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
	const row = await getPublishedBundleArtifactByIdentity(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.sourceId,
		artifactKind: input.kind,
		artifactName: normalizeArtifactName(input.artifactName),
		entryPoint: normalizeEntryPoint(input.entryPoint),
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
	return {
		row,
		artifact,
	}
}

export async function rebuildPublishedPackageArtifacts(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	savedPackage: SavedPackageRecord
	manifest: AuthoredPackageJson
	files: Record<string, string>
	buildAppBundle: (args: {
		entryPoint: string
	}) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies?: Array<BundleArtifactDependency>
	}>
	buildModuleBundle: (args: {
		entryPoint: string
	}) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies?: Array<BundleArtifactDependency>
	}>
}) {
	const fallbackDependencies = await collectDependenciesFromFiles({
		env: input.env,
		userId: input.userId,
		files: input.files,
	})
	if (input.manifest.kody.app) {
		const entryPoint = getPackageAppEntryPath(input.manifest)
		if (entryPoint) {
			const bundle = await input.buildAppBundle({ entryPoint })
			await persistPublishedBundleArtifact({
				env: input.env,
				userId: input.userId,
				source: input.source,
				kind: 'app',
				entryPoint,
				mainModule: bundle.mainModule,
				modules: bundle.modules,
				dependencies: bundle.dependencies ?? fallbackDependencies,
				packageContext: {
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
				},
			})
		}
	}
	for (const [exportName, exportTarget] of Object.entries(
		input.manifest.exports,
	) as Array<[string, AuthoredPackageJson['exports'][string]]>) {
		const entryPoint =
			typeof exportTarget === 'string'
				? exportTarget
				: exportTarget.import ?? exportTarget.default ?? null
		if (!entryPoint) continue
		const bundle = await input.buildModuleBundle({
			entryPoint,
		})
		await persistPublishedBundleArtifact({
			env: input.env,
			userId: input.userId,
			source: input.source,
			kind: 'module',
			artifactName: exportName,
			entryPoint,
			mainModule: bundle.mainModule,
			modules: bundle.modules,
			dependencies: bundle.dependencies ?? fallbackDependencies,
			packageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
		})
	}
	for (const [jobName, jobDefinition] of Object.entries(
		input.manifest.kody.jobs ?? {},
	) as Array<[string, NonNullable<AuthoredPackageJson['kody']['jobs']>[string]]>) {
		const bundle = await input.buildModuleBundle({
			entryPoint: jobDefinition.entry,
		})
		await persistPublishedBundleArtifact({
			env: input.env,
			userId: input.userId,
			source: input.source,
			kind: 'job',
			artifactName: jobName,
			entryPoint: jobDefinition.entry,
			mainModule: bundle.mainModule,
			modules: bundle.modules,
			dependencies: bundle.dependencies ?? fallbackDependencies,
			packageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
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
		await Promise.allSettled(
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
