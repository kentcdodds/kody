import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceBySourceId,
	loadPackageSourceRowForUser,
	type LoadedPackageManifest,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from '#worker/package-runtime/published-source-dependencies.ts'
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import {
	normalizeExportName,
	type PackageModuleResolution,
	type PackageModuleSelector,
} from './common.ts'
import {
	loadModuleArtifactWithCommitCache,
	loadSourceRowWithFreshnessCache,
	resolveSavedPackageWithFreshnessCache,
	type CachedInvokeModuleArtifact,
} from './invoke-contract-cache.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'

export async function resolveSavedPackage(input: {
	db: D1Database
	userId: string
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord | null> {
	return await resolveSavedPackageWithFreshnessCache({
		userId: input.userId,
		packageIdOrKodyId: input.packageIdOrKodyId,
		load: async () =>
			(await getSavedPackageById(input.db, {
				userId: input.userId,
				packageId: input.packageIdOrKodyId,
			})) ??
			(await getSavedPackageByKodyId(input.db, {
				userId: input.userId,
				kodyId: input.packageIdOrKodyId,
			})),
	})
}

/**
 * Manifest load for invocation paths: the entity-source row (the freshness
 * anchor carrying `published_commit`) comes from the short-TTL invoke
 * contract cache, and the manifest itself from the commit-keyed manifest
 * cache. Warm calls perform zero D1/KV loads. Publish and rebuild flows must
 * keep using `loadPackageManifestBySourceId`, which always reads the row
 * fresh.
 */
export async function loadInvokeManifestBySourceId(input: {
	env: Env
	userId: string
	sourceId: string
}): Promise<LoadedPackageManifest> {
	const source = await loadSourceRowWithFreshnessCache({
		userId: input.userId,
		sourceId: input.sourceId,
		load: () =>
			loadPackageSourceRowForUser({
				env: input.env,
				userId: input.userId,
				sourceId: input.sourceId,
			}),
	})
	return await loadPackageManifestForSource({
		env: input.env,
		userId: input.userId,
		source,
	})
}

export async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	packageManifest?: LoadedPackageManifest
	resolution?: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}): Promise<CachedInvokeModuleArtifact> {
	const packageManifest =
		input.packageManifest ??
		(await loadInvokeManifestBySourceId({
			env: input.env,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		}))
	const resolution =
		input.resolution ??
		resolvePackageModuleResolution({
			manifest: packageManifest.manifest,
			selector: input.selector,
		})
	return await loadModuleArtifactWithCommitCache({
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		publishedCommit: packageManifest.source.published_commit,
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
		load: () =>
			ensureModuleArtifactUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				packageManifest,
				resolution,
				savedPackage: input.savedPackage,
				selector: input.selector,
				userId: input.userId,
			}),
	})
}

async function ensureModuleArtifactUncached(input: {
	env: Env
	baseUrl: string
	packageManifest: LoadedPackageManifest
	resolution: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}): Promise<CachedInvokeModuleArtifact> {
	const { packageManifest, resolution } = input
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
	})
	if (loaded?.artifact) {
		return {
			artifact: loaded.artifact,
			source: packageManifest.source,
			entryPoint: resolution.entryPoint,
		}
	}
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	// The caller's manifest may come from the freshness-cached source row and
	// trail a republish by up to the freshness TTL, while the source load
	// above is always current. Re-derive the module resolution from the
	// freshly loaded manifest so the typecheck, bundle, and persisted
	// artifact identity are all self-consistent with the commit being built.
	const freshResolution = resolvePackageModuleResolution({
		manifest: packageSource.manifest,
		selector: input.selector,
	})
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: freshResolution.entryPoint, includeStorage: true }],
		emittedEventTopics: Object.keys(packageSource.manifest.kody.emits ?? {}),
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: packageSource.files,
		bundleLabel: `Saved package export "${freshResolution.artifactName}"`,
	})
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	const bundle = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: packageSource.files,
		entryPoint: freshResolution.entryPoint,
		rootPackageId: input.savedPackage.id,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: packageSource.source,
		kind: 'module',
		artifactName: freshResolution.artifactName,
		entryPoint: freshResolution.entryPoint,
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
	const rebuilt = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: freshResolution.artifactName,
		entryPoint: freshResolution.entryPoint,
	})
	if (!rebuilt?.artifact) {
		const moduleLabel =
			input.selector.kind === 'export'
				? `export "${input.selector.exportName}"`
				: `subscription "${input.selector.topic}"`
		throw new Error(
			`Published bundle artifact for ${moduleLabel} could not be loaded after rebuild.`,
		)
	}
	return {
		artifact: rebuilt.artifact,
		source: packageSource.source,
		entryPoint: freshResolution.entryPoint,
	}
}

export function resolvePackageModuleResolution(input: {
	manifest: Awaited<ReturnType<typeof loadPackageSourceBySourceId>>['manifest']
	selector: PackageModuleSelector
}): PackageModuleResolution {
	switch (input.selector.kind) {
		case 'export': {
			const exportName = normalizeExportName(input.selector.exportName)
			return {
				artifactName: exportName,
				entryPoint: resolvePackageExportPath({
					manifest: input.manifest,
					exportName,
				}),
			}
		}
		case 'subscription': {
			const topic = normalizePackageSubscriptionTopic(input.selector.topic)
			const handler = input.manifest.kody.subscriptions?.[topic]?.handler
			if (!handler) {
				throw new Error(
					`Package "${input.manifest.kody.id}" does not define subscription "${topic}".`,
				)
			}
			return {
				artifactName: buildPackageSubscriptionArtifactName(topic),
				entryPoint: normalizePackageWorkspacePath(handler),
			}
		}
		default: {
			const selector: never = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

export function isMissingPackageModuleError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('does not define export') ||
			error.message.includes('does not define a runtime target') ||
			error.message.includes('does not define subscription'))
	)
}

export function isTransientModuleArtifactError(error: unknown) {
	if (isRetryableD1LockError(error)) return true
	if (!(error instanceof Error)) return false
	return /(?:\bD1\b|\bKV\b|bindings? (?:are|is) not available|timeout|temporar|network|fetch|could not be loaded after rebuild)/i.test(
		error.message,
	)
}
