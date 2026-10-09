import { throwIfPersonPackagePlatformReference } from '#worker/package-registry/platform-package-policy.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	normalizePackageExportKey,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { assertNotSealedSecretProviderExport } from '#mcp/secrets/secret-providers/sealed-export.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type PublishedBundleArtifact } from './published-runtime-artifacts.ts'
import {
	parseKodyPackageSpecifier,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	createDynamicPackageImportArtifactKey,
	collectDynamicPackageImportsFromModules,
	createPublishedBundleArtifact,
	installDynamicPackageArtifactModules,
} from './module-graph-artifacts.ts'
import { buildKodyImportableModuleBundle } from './module-graph-bundle-builders.ts'
import {
	createDynamicPackageImportProxySource,
	refreshKodyRuntimeModules,
} from './runtime-source-modules.ts'
import { createRelativeImportSpecifier } from './module-graph-paths.ts'

/**
 * Resolve a caller-owned (or forked / share-granted) `kody:@` specifier to its
 * published `importable-module` artifact. Used by literal dynamic-import
 * hydration and by computed `import(specifier)` library loads
 * ([#1750](https://github.com/kentcdodds/kody/issues/1750)).
 * Never live-resolves platform scopes (`allowPlatformScopes: false`).
 * Source and published artifacts load under `sourceOwnerUserId` so share
 * guests match static `kody:@` imports. Rebuild+persist stays owner-only.
 */
export async function resolveCurrentDynamicPackageArtifact(input: {
	env: Env
	baseUrl: string
	userId: string
	specifier: string
}) {
	if (!input.userId) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" requires an authenticated user.`,
		)
	}
	const parsed = parseKodyPackageSpecifier(input.specifier)
	assertNotSealedSecretProviderExport(parsed.exportName)
	// Person accounts never resolve platform-owned sources here.
	const resolution = await resolveSavedPackageImport({
		db: input.env.APP_DB,
		userId: input.userId,
		specifier: parsed,
		allowPlatformScopes: false,
	})
	if (!resolution) {
		await throwIfPersonPackagePlatformReference({
			db: input.env.APP_DB,
			packageName: parsed.packageName,
		})
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" could not find saved package "${parsed.packageName}" for this user.`,
		)
	}
	const { row } = resolution
	const sourceOwnerUserId = resolution.sourceOwnerUserId
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: sourceOwnerUserId,
		sourceId: row.sourceId,
	})
	if (!loaded.source.published_commit) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" resolved saved package "${row.name}" source "${row.sourceId}", but it has no published commit.`,
		)
	}
	const exportName = normalizePackageExportKey(parsed.exportName)
	const entryPoint = resolvePackageExportPath({
		manifest: loaded.manifest,
		exportName,
	})
	// Published artifacts are owned by the source owner (own package, share
	// grant, or nested share rewrite), matching static import rewriting.
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: sourceOwnerUserId,
		sourceId: row.sourceId,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
	})
	if (loadedArtifact?.artifact) {
		return loadedArtifact.artifact
	}
	// Share guests must not rebuild or persist under the owner's identity, and
	// persisting under the guest would leave the next owner-keyed load cold.
	if (resolution.shareOwned === true && sourceOwnerUserId !== input.userId) {
		throw new Error(
			`Dynamic Kody package import "${input.specifier}" resolved shared package "${row.name}", but its published importable-module artifact for "${exportName}" is missing. Ask the package owner to publish again.`,
		)
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: loaded.files,
		bundleLabel: `Dynamic Kody package import "${input.specifier}"`,
	})
	const rebuilt = await buildKodyImportableModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: sourceOwnerUserId,
		sourceFiles: loaded.files,
		entryPoint,
		rootPackageId: row.id,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: sourceOwnerUserId,
		source: loaded.source,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
		mainModule: rebuilt.mainModule,
		modules: rebuilt.modules,
		dependencies: rebuilt.dependencies,
		dynamicDependencies: rebuilt.dynamicDependencies,
		packageContext: {
			packageId: row.id,
			kodyId: row.kodyId,
			sourceId: row.sourceId,
		},
	})
	return createPublishedBundleArtifact({
		kind: 'importable-module',
		artifactName: exportName,
		sourceId: loaded.source.id,
		publishedCommit: loaded.source.published_commit,
		entryPoint,
		mainModule: rebuilt.mainModule,
		modules: rebuilt.modules,
		dependencies: rebuilt.dependencies,
		dynamicDependencies: rebuilt.dynamicDependencies,
		packageContext: {
			packageId: row.id,
			kodyId: row.kodyId,
			sourceId: row.sourceId,
		},
	})
}

export type HydratedKodyRuntimeModules = {
	modules: WorkerLoaderModules
	/**
	 * Saved-package UUIDs of the published artifacts installed for literal
	 * dynamic `import("kody:@...")` targets during hydration. Host-resolved
	 * provenance (never sandbox input), so callers may extend `packageStorage`
	 * grants with these ids alongside static bundle dependency metadata.
	 */
	dynamicDependencyPackageIds: Array<string>
}

export async function hydrateKodyRuntimeModules(input: {
	env: Env
	baseUrl: string
	userId: string
	modules: WorkerLoaderModules
}): Promise<HydratedKodyRuntimeModules> {
	const modules = refreshKodyRuntimeModules(input.modules)
	const installedArtifacts = new Map<string, string>()
	const resolvedArtifacts = new Map<
		string,
		{
			artifactKey: string
			artifact: PublishedBundleArtifact
			installedArtifactMainModule?: string
		}
	>()
	while (true) {
		let installedDynamicImport = false
		const dynamicImportEntries =
			collectDynamicPackageImportsFromModules(modules)
		const unresolvedSpecifiers = [
			...new Set(
				dynamicImportEntries
					.map((entry) => entry.specifier)
					.filter((specifier) => !resolvedArtifacts.has(specifier)),
			),
		]
		await Promise.all(
			unresolvedSpecifiers.map(async (specifier) => {
				const artifact = await resolveCurrentDynamicPackageArtifact({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					specifier,
				})
				resolvedArtifacts.set(specifier, {
					artifactKey: createDynamicPackageImportArtifactKey({
						specifier,
						artifact,
					}),
					artifact,
				})
			}),
		)
		for (const entry of dynamicImportEntries) {
			const resolved = resolvedArtifacts.get(entry.specifier)
			if (!resolved) continue
			const existingArtifactMainModule =
				resolved.installedArtifactMainModule ??
				installedArtifacts.get(resolved.artifactKey)
			if (existingArtifactMainModule) {
				modules[entry.modulePath] = createDynamicPackageImportProxySource({
					targetPath: createRelativeImportSpecifier(
						entry.modulePath,
						existingArtifactMainModule,
					),
				})
				continue
			}
			const installedArtifactMainModule = installDynamicPackageArtifactModules({
				modules,
				modulePath: entry.modulePath,
				specifier: entry.specifier,
				artifact: resolved.artifact,
			})
			resolved.installedArtifactMainModule = installedArtifactMainModule
			installedArtifacts.set(resolved.artifactKey, installedArtifactMainModule)
			installedDynamicImport = true
		}
		if (!installedDynamicImport) {
			const dynamicDependencyPackageIds = [
				...new Set(
					[...resolvedArtifacts.values()].flatMap((resolved) => {
						const packageId = resolved.artifact.packageContext?.packageId
						return packageId ? [packageId] : []
					}),
				),
			].sort((left, right) => left.localeCompare(right))
			return {
				modules: refreshKodyRuntimeModules(modules),
				dynamicDependencyPackageIds,
			}
		}
	}
}
