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
 * PR1: root package only (secret mounts + user secrets this package can use,
 * plus its own storage grant). Transitive dependency walking lands in the
 * follow-up that pins internet-visible trees.
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

	let secretMountNames = new Set<string>()
	try {
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: getAppBaseUrl({
				env: input.env,
				requestUrl: input.requestUrl,
			}),
			userId: input.ownerUserId,
			sourceId: input.sourceId,
		})
		for (const mount of Object.values(
			loaded.manifest.kody.secretMounts ?? {},
		)) {
			if (mount.scope === 'package' || mount.scope === 'session') continue
			const name = mount.name.trim()
			if (name) secretMountNames.add(name)
		}
	} catch {
		secretMountNames = new Set()
	}

	const listed = await listSecrets({
		env: input.env,
		userId: input.ownerUserId,
		scope: 'user',
	})

	const hasImplicitRead = await packageHasImplicitUserSecretReadAccess({
		env: input.env,
		userId: input.ownerUserId,
		packageId: input.packageId,
	})

	for (const secret of listed) {
		const granted =
			secret.allowedPackages.includes(input.packageId) || hasImplicitRead
		const mounted = secretMountNames.has(secret.name)
		if (!granted && !mounted) continue
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
