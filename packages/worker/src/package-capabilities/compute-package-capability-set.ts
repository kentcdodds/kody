import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { packageHasImplicitUserSecretReadAccess } from '#mcp/secrets/package-access.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	buildCapabilitySet,
	type CapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'

/**
 * Compute the capability set for a package.
 *
 * PR1: root package only (secret mounts + secrets this package can use,
 * plus its own storage grant). Transitive dependency walking lands in the
 * follow-up that pins internet-visible trees.
 *
 * Callers must only invoke this when a published commit exists. Manifest load
 * failures fail closed (throw) so approval cannot silently omit mounts.
 */
export async function computePackageCapabilitySet(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	requestUrl: string
}): Promise<CapabilitySet> {
	const entries: Array<CapabilitySetEntry> = []
	const via = [input.packageKodyId]

	entries.push({
		kind: 'storage',
		storageId: input.packageId,
		hosts: [],
		via,
	})

	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		userId: input.ownerUserId,
		sourceId: input.sourceId,
	})
	const userMountNames = new Set<string>()
	for (const mount of Object.values(loaded.manifest.kody.secretMounts ?? {})) {
		const name = mount.name.trim()
		if (!name) continue
		// Only user-scoped mounts can pull user secrets into the set. Package
		// mounts resolve against the package bucket (listed below).
		if (mount.scope === 'user') userMountNames.add(name)
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
		// Package-bucket secrets are always reachable for this package.
		seenCredentialIds.add(secret.credentialId)
		entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via,
		})
	}
	for (const secret of userSecrets) {
		if (seenCredentialIds.has(secret.credentialId)) continue
		const granted =
			secret.allowedPackages.includes(input.packageId) || hasImplicitRead
		const mounted = userMountNames.has(secret.name)
		if (!granted && !mounted) continue
		seenCredentialIds.add(secret.credentialId)
		entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via,
		})
	}

	return buildCapabilitySet(entries)
}
