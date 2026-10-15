import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { type resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { getLatestPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'
import {
	approvePackageCapabilitySet,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

type PackageAppSlugLookup = Awaited<
	ReturnType<typeof resolveSavedPackageForPackageAppSlug>
>

/**
 * Per-isolate cache of the commit anonymous visitors may run per app, same
 * 15 s freshness tier as the slug lookup it pairs with. Serve still refuses
 * anonymous requests whose live published commit differs, so a stale entry
 * never widens what anonymous visitors run.
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
	requestUrl: string
}): Promise<string | null> {
	const savedPackage = input.lookup?.savedPackage
	if (!savedPackage?.hasApp || !savedPackage.isInternetVisible) return null
	return await approvedCommitCache.getOrCreate({
		cacheKey: savedPackage.id,
		create: async () =>
			await loadApprovedCommit({
				env: input.env,
				savedPackage,
				requestUrl: input.requestUrl,
			}),
	})
}

async function loadApprovedCommit(input: {
	env: Env
	savedPackage: SavedPackageRecord
	requestUrl: string
}): Promise<string | null> {
	const { env, savedPackage } = input
	const ownerUserId = savedPackage.userId
	const approval = await getLatestPackageCapabilityApproval(env.APP_DB, {
		packageId: savedPackage.id,
		ownerUserId,
	})
	if (!approval) return null
	const source = await getEntitySourceById(env.APP_DB, savedPackage.sourceId)
	const liveCommit =
		source?.user_id === savedPackage.userId ? source.published_commit : null
	if (!liveCommit || liveCommit === approval.publishedCommit) {
		return approval.publishedCommit
	}
	return (
		(await acceptRepublishedCommit({ ...input, liveCommit })) ??
		approval.publishedCommit
	)
}

/**
 * A republish whose capability set matches an approved fingerprint is
 * already accepted (ADR 0069), so record the pin for the new commit instead
 * of taking the public site offline until the owner re-approves. Runs once
 * per published commit; later lookups find the new approval row directly.
 * Any failure keeps serving pinned to the older approval, which serve then
 * refuses for the newer commit.
 */
async function acceptRepublishedCommit(input: {
	env: Env
	savedPackage: SavedPackageRecord
	requestUrl: string
	liveCommit: string
}): Promise<string | null> {
	const ownerUserId = input.savedPackage.userId
	try {
		const summary = await loadCapabilityApprovalSummary({
			env: input.env,
			ownerUserId,
			savedPackage: input.savedPackage,
			requestUrl: input.requestUrl,
		})
		if (
			!summary.matchingApproval ||
			summary.publishedCommit !== input.liveCommit
		) {
			return null
		}
		const { approval } = await approvePackageCapabilitySet({
			env: input.env,
			ownerUserId,
			actorUserId: summary.matchingApproval.approvedByUserId,
			savedPackage: input.savedPackage,
			requestUrl: input.requestUrl,
			expectedFingerprint: summary.capabilitySet.fingerprint,
			enqueueWentPublic: false,
		})
		return approval.publishedCommit === input.liveCommit
			? input.liveCommit
			: null
	} catch (error) {
		console.warn('package-app-internet-visible: republish accept failed', {
			packageId: input.savedPackage.id,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
