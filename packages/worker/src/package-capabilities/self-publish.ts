/**
 * Self-publish (issue #3822): an agent's request to make a package
 * internet-visible is approved without the owner's click when nothing in the
 * package's resolved dependency tree declares a credential or any other
 * capability, and a security audit with verdict `pass` is recorded for the
 * package's current published commit and capability fingerprint. It is tried
 * when `packageUpdate` turns internet-visible on, and again when
 * `packageSecurityAuditRecord` records a pass while a `went_public` request is
 * pending. It needs credential-need enforcement on, because only then does
 * declaring nothing mean the fetch gateway and `credential()` fill nothing for
 * it. The credential door refuses every credential to a self-published package
 * (`assertSelfPublishedPackageResolvesNothing`), which covers the by-name
 * helpers enforcement does not reach.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	AuthorizationError,
	authorizePackageWrite,
} from '#worker/authorization/authorize.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { approveWentPublicRequest } from '#app/account-package-approval-requests.ts'
import { credentialNeedEnforcementFlagKey } from '#universal/feature-flags/registry.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { isFeatureGloballyEnabled } from '#worker/feature-flags/service.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import {
	approvePackageCapabilitySet,
	type CapabilityApprovalSummary,
} from './capability-approval-service.ts'
import {
	enqueueWentPublicApproval,
	isSelfPublishRequest,
	setSelfPublishMark,
} from './went-public-approval.ts'
import { loadCurrentPackageSecurityAudit } from './security-audit-state.ts'

export const selfPublishAuditAction = 'package.went_public.self_publish'

export type SelfPublishBlocker =
	| 'enforcement_off'
	| 'unpublished'
	| 'stale_dependencies'
	| 'declares_credentials'
	| 'declares_capabilities'
	| 'not_audited'
	| 'audit_concerns'

export type SelfPublishEligibility =
	| { eligible: true }
	| { eligible: false; blocker: SelfPublishBlocker }

/** Manifest fields that declare a capability beyond the package's storage. */
const capabilityFields = [
	'secretMounts',
	'secretProvider',
	'subscriptions',
	'emits',
	'jobs',
	'retrievers',
	'webhooks',
] as const satisfies ReadonlyArray<keyof AuthoredPackageJson['kody']>

function declaresAny(value: unknown) {
	if (value == null) return false
	if (Array.isArray(value)) return value.length > 0
	if (typeof value === 'object') return Object.keys(value).length > 0
	return true
}

async function evaluateTreePackage(
	env: Env,
	sourceId: string,
	pinnedCommit: string,
): Promise<SelfPublishBlocker | null> {
	const source = await getEntitySourceById(env.APP_DB, sourceId)
	if (!source?.published_commit) return 'unpublished'
	// Only the published version is read, so it has to be the one serving pins.
	if (source.published_commit !== pinnedCommit) return 'stale_dependencies'
	const { manifest } = await loadPublishedEntityManifest({
		env,
		userId: source.user_id,
		sourceId,
		source,
	})
	const kody = manifest.kody
	if (
		declaresAny(kody.credentials) ||
		declaresAny(kody.invalidCredentialSlots)
	) {
		return 'declares_credentials'
	}
	if (capabilityFields.some((field) => declaresAny(kody[field]))) {
		return 'declares_capabilities'
	}
	const needs = await loadPublishedCredentialNeeds({
		env,
		userId: source.user_id,
		sourceId,
		fresh: true,
	})
	return needs.length > 0 ? 'declares_credentials' : null
}

/**
 * Whether going internet-visible may skip the owner's Approve: enforcement is
 * on, the package and every package in its resolved dependency tree are
 * published and declare no credential and no capability, and the current
 * published commit + fingerprint has a passing security audit.
 */
export async function evaluateSelfPublish(input: {
	env: Env
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
}): Promise<SelfPublishEligibility> {
	if (
		!(await isFeatureGloballyEnabled(
			input.env.APP_DB,
			credentialNeedEnforcementFlagKey,
		))
	) {
		return { eligible: false, blocker: 'enforcement_off' }
	}
	if (!input.summary.publishedCommit) {
		return { eligible: false, blocker: 'unpublished' }
	}
	const pinned = new Map([
		[input.savedPackage.sourceId, input.summary.publishedCommit],
		...(input.summary.dependencySnapshot?.dependencies ?? []).map(
			(dependency) =>
				[dependency.sourceId, dependency.publishedCommit] as const,
		),
	])
	for (const [sourceId, commit] of pinned) {
		const blocker = await evaluateTreePackage(input.env, sourceId, commit)
		if (blocker) return { eligible: false, blocker }
	}
	const audit = await loadCurrentPackageSecurityAudit(input.env.APP_DB, {
		ownerUserId: input.savedPackage.userId,
		packageId: input.savedPackage.id,
		publishedCommit: input.summary.publishedCommit,
		fingerprint: input.summary.capabilitySet.fingerprint,
	})
	if (!audit) return { eligible: false, blocker: 'not_audited' }
	if (audit.verdict !== 'pass') {
		return { eligible: false, blocker: 'audit_concerns' }
	}
	return { eligible: true }
}

export type SelfPublishResult = { ok: true } | { ok: false; error: string }

/**
 * Makes an eligible package internet-visible: records the capability pin and
 * a `went_public` request marked self-publish, approves that request through
 * the owner's own approval code, and audits the decision once. Call only
 * after {@link evaluateSelfPublish} returned eligible for this summary.
 */
export async function selfPublishPackage(input: {
	env: Env
	request: RequestContext
	requestUrl: string
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
}): Promise<SelfPublishResult> {
	const { env, savedPackage } = input
	const fingerprint = input.summary.capabilitySet.fingerprint
	const audit = (
		result: 'success' | 'failure',
		details: Record<string, unknown>,
	) =>
		logOrgAuditEvent({
			env,
			orgId: input.ownerUserId,
			action: selfPublishAuditAction,
			result,
			actorUserId: input.request.actor?.userId ?? input.actorUserId,
			actorUsername: input.request.actor?.username ?? null,
			credentialKind: input.request.credential.kind,
			credentialId: input.request.credential.id,
			resourceType: 'package',
			resourceId: savedPackage.id,
			details: {
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				fingerprint,
				publishedCommit: input.summary.publishedCommit,
				...details,
			},
		}).catch((error: unknown) => {
			console.error('Failed to audit self-publish:', {
				packageId: savedPackage.id,
				error: getErrorMessage(error),
			})
		})
	const approved = await approvePackageCapabilitySet({
		env,
		ownerUserId: input.ownerUserId,
		actorUserId: input.actorUserId,
		savedPackage,
		requestUrl: input.requestUrl,
		expectedFingerprint: fingerprint,
		enqueueWentPublic: false,
	})
	// The audit vouches for one commit. A publish since evaluation keeps the
	// fingerprint but not the audit; binding the request's base commit to the
	// audited one makes the approval refuse once the live commit moves.
	if (approved.approval.publishedCommit !== input.summary.publishedCommit) {
		const error =
			'The package was published again since its security audit, so it was left for the owner. Audit the new version, then try again.'
		await audit('failure', {
			approvalId: approved.approval.id,
			pinnedCommit: approved.approval.publishedCommit,
			error,
		})
		return { ok: false, error }
	}
	// Enqueue reuses a pending owner-path request for the same commit, so the
	// one pending request is marked in place, and unmarked again on any
	// failure: it stays pending for the owner either way, and an owner Approve
	// never reads as self-publish.
	const wentPublic = await enqueueWentPublicApproval({
		env,
		ownerUserId: input.ownerUserId,
		savedPackage,
		publishedCommit: approved.approval.publishedCommit,
		fingerprint,
		requestedByUserId: input.actorUserId,
		selfPublish: true,
	})
	if (
		!isSelfPublishRequest(wentPublic) &&
		!(await setSelfPublishMark(env, wentPublic.id, true))
	) {
		const error =
			'The request to make this package internet-visible was resolved meanwhile, so nothing was approved.'
		await audit('failure', { requestId: wentPublic.id, error })
		return { ok: false, error }
	}
	let result: Awaited<ReturnType<typeof approveWentPublicRequest>>
	try {
		result = await approveWentPublicRequest({
			env,
			request: new Request(input.requestUrl),
			savedPackage,
			ownerUserId: input.ownerUserId,
			actorUserId: input.actorUserId,
			requestId: wentPublic.id,
		})
	} catch (error) {
		await setSelfPublishMark(env, wentPublic.id, false)
		throw error
	}
	if (!result.ok) await setSelfPublishMark(env, wentPublic.id, false)
	await audit(
		result.ok ? 'success' : 'failure',
		result.ok
			? { requestId: wentPublic.id, approvalId: approved.approval.id }
			: { requestId: wentPublic.id, error: result.error },
	)
	return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** Self-publish approves for the owner, so it takes publish permission. */
async function mayPublishPackage(
	ctx: { env: Env; request: RequestContext | null },
	pkg: SavedPackageRecord,
) {
	try {
		await authorizePackageWrite(
			ctx,
			{ id: pkg.id, userId: pkg.userId, label: pkg.name },
			'package:publish',
		)
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}

export type SelfPublishAttempt =
	| { status: 'self_published' }
	| { status: 'blocked'; blocker: SelfPublishBlocker | 'not_permitted' }
	| { status: 'failed'; error: string }

/**
 * Evaluates and, when eligible and the caller may publish the package,
 * self-publishes it. Nothing is written when it is blocked.
 */
export async function attemptSelfPublish(input: {
	env: Env
	request: RequestContext
	requestUrl: string
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
}): Promise<SelfPublishAttempt> {
	const eligibility = await evaluateSelfPublish(input)
	if (!eligibility.eligible) {
		return { status: 'blocked', blocker: eligibility.blocker }
	}
	if (
		!(await mayPublishPackage(
			{ env: input.env, request: input.request },
			input.savedPackage,
		))
	) {
		return { status: 'blocked', blocker: 'not_permitted' }
	}
	const result = await selfPublishPackage(input)
	return result.ok
		? { status: 'self_published' }
		: { status: 'failed', error: result.error }
}
