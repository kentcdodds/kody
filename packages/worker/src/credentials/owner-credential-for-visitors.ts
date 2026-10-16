/**
 * Owner credentials for visitors of an internet-visible package app
 * (`ownerCredentialForVisitors`, ADR 0068 amendment 2026-10-16).
 *
 * A package-app run keeps its viewer: the signed-in visitor, or none. A need
 * that opts in resolves instead with a credential authority: the person who
 * approved the app's capability set, acting with the role they hold in the
 * owning org right now, like a trigger acts as its enabler. It applies only
 * while the app is internet-visible and its running commit is the approved
 * one, and only to the credentials that approval listed for that need. Other
 * needs, and everything else the run does, still act as the viewer.
 */
import {
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { getLatestPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'
import { visitorCredentialIdsByNeedKey } from '#worker/package-capabilities/capability-set.ts'
import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

/** The package-app run an opted-in need may resolve owner credentials in. */
export type OwnerCredentialScope = {
	/** The org that owns the app. */
	orgId: OwnerId
	/** The app package whose approval applies (the run's root package). */
	packageId: string
	/** The commit the run serves. */
	publishedCommit: string | null
}

export type OwnerCredentialAuthority =
	/** Not internet-visible, or not the approved commit: the viewer resolves. */
	| { status: 'not-shared' }
	/** Shared, but the approving owner can no longer use the org's credentials. */
	| { status: 'unavailable'; message: string }
	| {
			status: 'ready'
			request: RequestContext
			/** Credential ids the approval lets visitors use, by need key. */
			approvedCredentialIds: ReadonlyMap<string, ReadonlySet<string>>
	  }

/**
 * Same freshness tier as the approved-commit lookup anonymous serving uses,
 * so a warm visitor request reads nothing extra. The door still re-checks
 * the authority's org access on its first use of each cached context.
 */
const authorityCache = new PromiseLruCache<OwnerCredentialAuthority>({
	ttlMs: invokeContractFreshnessTtlMs,
	limit: invokeContractFreshnessCacheLimit,
})

const notShared: OwnerCredentialAuthority = { status: 'not-shared' }

export async function loadOwnerCredentialAuthority(input: {
	env: Pick<Env, 'APP_DB'>
	scope: OwnerCredentialScope
}): Promise<OwnerCredentialAuthority> {
	const { scope } = input
	if (!scope.publishedCommit) return notShared
	const cached = await authorityCache.getOrCreate({
		cacheKey: JSON.stringify([
			scope.orgId,
			scope.packageId,
			scope.publishedCommit,
		]),
		create: () => resolveAuthority(input.env.APP_DB, scope),
	})
	// The cache may outlive a suspend/delete/leave. Re-check the approving
	// person before handing visitors their credentials.
	return await refreshReadyAuthority(input.env.APP_DB, scope, cached)
}

async function refreshReadyAuthority(
	db: D1Database,
	scope: OwnerCredentialScope,
	authority: OwnerCredentialAuthority,
): Promise<OwnerCredentialAuthority> {
	if (authority.status !== 'ready') return authority
	const personId = authority.request.actor?.userId
	if (!personId) {
		authorityCache.delete(
			JSON.stringify([scope.orgId, scope.packageId, scope.publishedCommit]),
		)
		return {
			status: 'unavailable',
			message:
				'The owner who approved this app for visitors can no longer use its org’s credentials. An owner must approve the app’s capabilities again.',
		}
	}
	const approver = await db
		.prepare(
			`SELECT username FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL
			   AND deleting_at IS NULL AND suspended_at IS NULL`,
		)
		.bind(personId)
		.first<{ username: string | null }>()
	const binding = approver
		? await loadOrgBindingForOrg(db, personId, scope.orgId)
		: null
	if (!approver || !binding) {
		authorityCache.delete(
			JSON.stringify([scope.orgId, scope.packageId, scope.publishedCommit]),
		)
		return {
			status: 'unavailable',
			message:
				'The owner who approved this app for visitors can no longer use its org’s credentials. An owner must approve the app’s capabilities again.',
		}
	}
	if (
		binding.role !== authority.request.membership?.role ||
		(approver.username ?? null) !== (authority.request.actor?.username ?? null)
	) {
		// Role or username changed: rebuild so the door sees the live binding.
		authorityCache.delete(
			JSON.stringify([scope.orgId, scope.packageId, scope.publishedCommit]),
		)
		return await resolveAuthority(db, scope)
	}
	const cacheKey = JSON.stringify([
		scope.orgId,
		scope.packageId,
		scope.publishedCommit,
	])
	// Always re-read the approved credential ids so a remapped or revoked
	// visitor credential fails on the next use, not after the cache TTL.
	const approval = await getLatestPackageCapabilityApproval(db, {
		packageId: scope.packageId,
		ownerUserId: scope.orgId,
	})
	if (!approval || approval.publishedCommit !== scope.publishedCommit) {
		authorityCache.delete(cacheKey)
		return notShared
	}
	if (personIdFromStored(approval.approvedByUserId) !== personId) {
		// A different owner re-approved: rebuild as that person.
		authorityCache.delete(cacheKey)
		return await resolveAuthority(db, scope)
	}
	const saved = await getSavedPackageById(db, {
		userId: scope.orgId,
		packageId: scope.packageId,
	})
	if (!saved?.hasApp || !saved.isInternetVisible) {
		authorityCache.delete(cacheKey)
		return notShared
	}
	return {
		status: 'ready',
		request: authority.request,
		approvedCredentialIds: visitorCredentialIdsByNeedKey(
			approval.capabilitySetJson,
		),
	}
}

async function resolveAuthority(
	db: D1Database,
	scope: OwnerCredentialScope,
): Promise<OwnerCredentialAuthority> {
	const saved = await getSavedPackageById(db, {
		userId: scope.orgId,
		packageId: scope.packageId,
	})
	if (!saved?.hasApp || !saved.isInternetVisible) return notShared
	const approval = await getLatestPackageCapabilityApproval(db, {
		packageId: scope.packageId,
		ownerUserId: scope.orgId,
	})
	if (!approval || approval.publishedCommit !== scope.publishedCommit) {
		return notShared
	}
	const approver = await db
		.prepare(
			`SELECT username FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL
			   AND deleting_at IS NULL AND suspended_at IS NULL`,
		)
		.bind(approval.approvedByUserId)
		.first<{ username: string | null }>()
	const binding = approver
		? await loadOrgBindingForOrg(db, approval.approvedByUserId, scope.orgId)
		: null
	if (!approver || !binding) {
		return {
			status: 'unavailable',
			message:
				'The owner who approved this app for visitors can no longer use its org’s credentials. An owner must approve the app’s capabilities again.',
		}
	}
	return {
		status: 'ready',
		request: deriveRequestContext({
			user: {
				userId: personIdFromStored(approval.approvedByUserId),
				username: approver.username ?? undefined,
			},
			source: { kind: 'package-app' },
			orgBinding: binding,
		}),
		approvedCredentialIds: visitorCredentialIdsByNeedKey(
			approval.capabilitySetJson,
		),
	}
}

/**
 * Who used the owner's credential, for the `credential.resolve` row, when
 * that is not the authority itself. Undefined when the owner is the viewer.
 */
export function ownerCredentialAuditDetails(input: {
	scope: OwnerCredentialScope
	authority: RequestContext
	viewer: RequestContext | null | undefined
}): Record<string, string | null> | undefined {
	const authorityUserId = input.authority.actor?.userId ?? null
	const viewerUserId = input.viewer?.actor?.userId ?? null
	if (viewerUserId !== null && viewerUserId === authorityUserId) {
		return undefined
	}
	return {
		ownerCredentialForVisitors: 'true',
		appPackageId: input.scope.packageId,
		credentialAuthorityUserId: authorityUserId,
		viewerUserId,
		viewerKind: viewerUserId ? 'person' : 'anonymous',
	}
}

/**
 * Uses of an owner's credential by every non-owner viewer of one app
 * credential. One shared budget (not per viewer) so a flood of one-time
 * visitors cannot grow `_rate_limits` without bound, and cannot run up the
 * owner's provider quota. The approving owner is not rate-limited.
 */
export const ownerCredentialForVisitorsRateLimitConfig = {
	maxRequests: 300,
	windowSeconds: 60,
}

export async function checkOwnerCredentialForVisitorsRateLimit(input: {
	db: D1Database
	scope: OwnerCredentialScope
	credentialId: string
}) {
	return await checkRateLimit(
		input.db,
		[
			'owner-credential-for-visitors',
			input.scope.orgId,
			input.scope.packageId,
			input.credentialId,
		].join(':'),
		ownerCredentialForVisitorsRateLimitConfig,
	)
}
