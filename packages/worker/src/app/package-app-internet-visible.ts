import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { type resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { getLatestPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

type PackageAppSlugLookup = Awaited<
	ReturnType<typeof resolveSavedPackageForPackageAppSlug>
>

/**
 * Per-isolate cache of the latest approved commit per app, same 15 s
 * freshness tier as the slug lookup it pairs with. A stale entry can only
 * name an older approval, and serve refuses anonymous requests whose live
 * published commit differs, so staleness never widens what anonymous
 * visitors run.
 */
const approvedCommitCache = new PromiseLruCache<string | null>({
	ttlMs: invokeContractFreshnessTtlMs,
	limit: invokeContractFreshnessCacheLimit,
})

/**
 * The published commit an internet-visible app may serve to anonymous
 * visitors (ADR 0069), or null when the app is not internet-visible or its
 * owner never approved a capability set for it.
 */
export async function resolveInternetVisibleApprovedCommit(input: {
	env: Env
	lookup: PackageAppSlugLookup
}): Promise<string | null> {
	const savedPackage = input.lookup?.savedPackage
	if (!savedPackage?.hasApp || !savedPackage.isInternetVisible) return null
	return await approvedCommitCache.getOrCreate({
		cacheKey: savedPackage.id,
		create: async () => {
			const approval = await getLatestPackageCapabilityApproval(
				input.env.APP_DB,
				{ packageId: savedPackage.id, ownerUserId: savedPackage.userId },
			)
			return approval?.publishedCommit ?? null
		},
	})
}
