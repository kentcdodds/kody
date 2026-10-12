import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { packageHasImplicitUserSecretReadAccess } from '#mcp/secrets/package-access.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { listPublishedBundleArtifactsBySourceId } from '#worker/repo/published-bundle-artifacts-repo.ts'
import { type BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	buildCapabilitySet,
	type CapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'
import {
	canonicalizeDependencySnapshot,
	emptyDependencySnapshot,
	type PackageDependencySnapshot,
} from './dependency-snapshot.ts'

export type PackageCapabilityComputeResult = {
	capabilitySet: CapabilitySet
	dependencySnapshot: PackageDependencySnapshot
}

/**
 * Compute the capability set for a package including transitive dependency
 * packages from the resolved published tree, and the lockfile-like dependency
 * snapshot used for internet-visible approval pins.
 *
 * Prefer dependencies recorded on the published `app` (or `module`) bundle
 * artifact for the root published commit. Fall back to walking declared
 * `kody.dependencies` when no artifact deps exist yet.
 *
 * Callers must only invoke this when a published commit exists. Manifest load
 * failures fail closed (throw) so approval cannot silently omit mounts.
 * Secret values never enter this path — only credential ids, hosts, and names.
 */
export async function computePackageCapabilitySet(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	requestUrl: string
	publishedCommit: string
}): Promise<PackageCapabilityComputeResult> {
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const entries: Array<CapabilitySetEntry> = []
	const viaRoot = [input.packageKodyId]

	await appendPackageCapabilityEntries({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		sourceId: input.sourceId,
		requestUrl: input.requestUrl,
		baseUrl,
		via: viaRoot,
		entries,
	})

	const dependencySnapshot = await resolveDependencySnapshot({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		baseUrl,
		requestUrl: input.requestUrl,
	})

	for (const dependency of dependencySnapshot.dependencies) {
		const packageId = await resolveDependencyPackageId({
			env: input.env,
			dependency,
		})
		if (!packageId) continue
		// Artifact dependency lists are flat (no parent chain). Provenance is
		// root → dependency kodyId; full intermediate paths need the graph walk
		// (manifest fallback tracks depth only as transitive today).
		const via = [input.packageKodyId, dependency.kodyId]
		await appendPackageCapabilityEntries({
			env: input.env,
			ownerUserId: input.ownerUserId,
			packageId,
			packageKodyId: dependency.kodyId,
			sourceId: dependency.sourceId,
			requestUrl: input.requestUrl,
			baseUrl,
			via,
			entries,
		})
	}

	return {
		capabilitySet: await buildCapabilitySet(entries),
		dependencySnapshot,
	}
}

async function resolveDependencySnapshot(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	publishedCommit: string
	baseUrl: string
	requestUrl: string
}): Promise<PackageDependencySnapshot> {
	const root = emptyDependencySnapshot({
		packageId: input.packageId,
		kodyId: input.packageKodyId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})

	const rootManifest = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.ownerUserId,
		sourceId: input.sourceId,
	})
	const hasApp = Boolean(rootManifest.manifest.kody.app?.entry?.trim())
	const fromArtifact = await loadDependenciesFromPublishedArtifact({
		env: input.env,
		ownerUserId: input.ownerUserId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		// Internet-visible is an app-serving flag. Never substitute a module
		// artifact's dependency list for an app package's approval pin.
		preferKind: hasApp ? 'app' : 'module',
	})
	if (fromArtifact) {
		return canonicalizeDependencySnapshot({
			...root,
			dependencies: fromArtifact,
		})
	}

	const fromManifest = await walkDeclaredKodyDependencies({
		env: input.env,
		ownerUserId: input.ownerUserId,
		sourceId: input.sourceId,
		baseUrl: input.baseUrl,
		rootPackageName: rootManifest.manifest.name,
	})
	return canonicalizeDependencySnapshot({
		...root,
		dependencies: fromManifest,
	})
}

async function resolveDependencyPackageId(input: {
	env: Env
	dependency: BundleArtifactDependency
}): Promise<string | null> {
	const explicit = input.dependency.packageId?.trim()
	if (explicit) return explicit
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.dependency.sourceId,
	)
	if (source?.entity_kind === 'package' && source.entity_id) {
		return source.entity_id
	}
	return null
}

async function loadDependenciesFromPublishedArtifact(input: {
	env: Env
	ownerUserId: OwnerId
	sourceId: string
	publishedCommit: string
	preferKind: 'app' | 'module'
}): Promise<Array<BundleArtifactDependency> | null> {
	const rows = (
		await listPublishedBundleArtifactsBySourceId(
			input.env.APP_DB,
			input.ownerUserId,
			input.sourceId,
		)
	).filter((row) => row.publishedCommit === input.publishedCommit)
	const preferred = rows.find((row) => row.artifactKind === input.preferKind)
	if (!preferred) return null
	try {
		const parsed = JSON.parse(preferred.dependenciesJson) as unknown
		if (!Array.isArray(parsed)) return []
		const dependencies: Array<BundleArtifactDependency> = []
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue
			const dep = entry as Record<string, unknown>
			const sourceId = String(dep.sourceId ?? '')
			const publishedCommit = String(dep.publishedCommit ?? '')
			const kodyId = String(dep.kodyId ?? '')
			if (!sourceId || !publishedCommit || !kodyId) continue
			const dependency: BundleArtifactDependency = {
				sourceId,
				publishedCommit,
				kodyId,
			}
			if (typeof dep.packageName === 'string' && dep.packageName.trim()) {
				dependency.packageName = dep.packageName
			}
			if (typeof dep.packageId === 'string' && dep.packageId.trim()) {
				dependency.packageId = dep.packageId
			}
			if (dep.transitive === true) {
				dependency.transitive = true
			}
			dependencies.push(dependency)
		}
		return dependencies
	} catch {
		// Malformed dependenciesJson: fall through to declared-deps walk.
		return null
	}
}

async function walkDeclaredKodyDependencies(input: {
	env: Env
	ownerUserId: OwnerId
	sourceId: string
	baseUrl: string
	rootPackageName: string
}): Promise<Array<BundleArtifactDependency>> {
	const dependencies = new Map<string, BundleArtifactDependency>()
	const visitedSourceIds = new Set<string>([input.sourceId])
	const queue: Array<{ sourceId: string; depth: number }> = [
		{ sourceId: input.sourceId, depth: 0 },
	]

	while (queue.length > 0) {
		const next = queue.shift()
		if (!next) continue
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.ownerUserId,
			sourceId: next.sourceId,
		})
		const names = listKodyPackageDependencyNames(
			loaded.manifest.kody.dependencies,
		)
		for (const packageName of names) {
			if (input.rootPackageName && packageName === input.rootPackageName) {
				continue
			}
			const resolution = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.ownerUserId,
				specifier: { packageName, exportName: '.' },
			})
			if (!resolution) continue
			const source = await getEntitySourceById(
				input.env.APP_DB,
				resolution.row.sourceId,
			)
			const publishedCommit = source?.published_commit ?? null
			if (!publishedCommit) continue
			if (!dependencies.has(resolution.row.id)) {
				const dependency: BundleArtifactDependency = {
					sourceId: resolution.row.sourceId,
					publishedCommit,
					kodyId: resolution.row.kodyId,
					packageName: resolution.row.name,
					packageId: resolution.row.id,
				}
				if (next.depth > 0) {
					dependency.transitive = true
				}
				dependencies.set(resolution.row.id, dependency)
			}
			if (!visitedSourceIds.has(resolution.row.sourceId)) {
				visitedSourceIds.add(resolution.row.sourceId)
				queue.push({
					sourceId: resolution.row.sourceId,
					depth: next.depth + 1,
				})
			}
		}
	}

	return [...dependencies.values()]
}

async function appendPackageCapabilityEntries(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	requestUrl: string
	baseUrl: string
	via: Array<string>
	entries: Array<CapabilitySetEntry>
}): Promise<void> {
	input.entries.push({
		kind: 'storage',
		storageId: input.packageId,
		hosts: [],
		via: input.via,
	})

	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.ownerUserId,
		sourceId: input.sourceId,
	})
	const userMountNames = new Set<string>()
	for (const mount of Object.values(loaded.manifest.kody.secretMounts ?? {})) {
		const name = mount.name.trim()
		if (!name) continue
		const scope = mount.scope ?? 'user'
		if (scope === 'user') userMountNames.add(name)
	}

	const packageStorageContext = {
		sessionId: null,
		appId: input.packageId,
		packageId: input.packageId,
		storageId: input.packageId,
	}

	const [userSecrets, packageSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: input.ownerUserId,
			scope: 'user',
		}),
		listSecrets({
			env: input.env,
			userId: input.ownerUserId,
			scope: 'package',
			storageContext: packageStorageContext,
		}),
	])

	const hasImplicitRead = await packageHasImplicitUserSecretReadAccess({
		env: input.env,
		userId: input.ownerUserId,
		packageId: input.packageId,
	})

	const seenCredentialIds = new Set<string>()
	for (const secret of packageSecrets) {
		if (seenCredentialIds.has(secret.credentialId)) continue
		seenCredentialIds.add(secret.credentialId)
		input.entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via: input.via,
		})
	}
	for (const secret of userSecrets) {
		if (seenCredentialIds.has(secret.credentialId)) continue
		const granted =
			secret.allowedPackages.includes(input.packageId) || hasImplicitRead
		const mounted = userMountNames.has(secret.name)
		if (!granted && !mounted) continue
		seenCredentialIds.add(secret.credentialId)
		input.entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via: input.via,
		})
	}
}
