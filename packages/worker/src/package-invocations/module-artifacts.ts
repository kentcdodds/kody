import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
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

export async function resolveSavedPackage(input: {
	db: D1Database
	userId: string
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord | null> {
	return (
		(await getSavedPackageById(input.db, {
			userId: input.userId,
			packageId: input.packageIdOrKodyId,
		})) ??
		(await getSavedPackageByKodyId(input.db, {
			userId: input.userId,
			kodyId: input.packageIdOrKodyId,
		}))
	)
}

export async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	packageManifest?: Awaited<ReturnType<typeof loadPackageManifestBySourceId>>
	resolution?: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}) {
	const packageManifest =
		input.packageManifest ??
		(await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		}))
	const resolution =
		input.resolution ??
		resolvePackageModuleResolution({
			manifest: packageManifest.manifest,
			selector: input.selector,
		})
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
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: resolution.entryPoint, includeStorage: true }],
		emittedEventTopics: Object.keys(packageSource.manifest.kody.emits ?? {}),
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: packageSource.files,
		bundleLabel: `Saved package export "${resolution.artifactName}"`,
	})
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	const bundle = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: packageSource.files,
		entryPoint: resolution.entryPoint,
		rootPackageId: input.savedPackage.id,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: packageSource.source,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
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
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
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
		entryPoint: resolution.entryPoint,
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
