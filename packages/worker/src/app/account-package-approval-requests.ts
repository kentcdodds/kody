import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	describeCredentialNeedChange,
	isPausedSessionMovedError,
	readCredentialNeedChanges,
	readPausedExternalPublish,
	readPausedSessionPublish,
} from '#worker/credentials/credential-needs-approval.ts'
import {
	getPackageApprovalRequest,
	listPendingPackageApprovalRequests,
	resolvePackageApprovalRequest,
	type PackageApprovalReason,
} from '#worker/package-capabilities/approval-requests-repo.ts'
import { loadCapabilityApprovalSummary } from '#worker/package-capabilities/capability-approval-service.ts'
import { readWentPublicSummary } from '#worker/package-capabilities/went-public-approval.ts'
import { updateSavedPackage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { getRepoSessionById } from '#worker/repo/repo-sessions.ts'
import {
	type RepoExternalPublishResult,
	type RepoSessionPublishResult,
} from '#worker/repo/types.ts'
import { type AccountPackagePendingApproval } from '#universal/loader-data.ts'

function reasonLabel(reason: PackageApprovalReason) {
	switch (reason) {
		case 'credential_needs_changed':
			return 'Credential needs changed'
		case 'went_public':
			return 'Went public'
		default: {
			const exhaustive: never = reason
			throw new Error(`Unknown approval reason: ${String(exhaustive)}`)
		}
	}
}

function approveAction(reason: PackageApprovalReason) {
	switch (reason) {
		case 'credential_needs_changed':
			return 'approve-credential-needs' as const
		case 'went_public':
			return 'approve-went-public' as const
		default: {
			const exhaustive: never = reason
			throw new Error(`Unknown approval reason: ${String(exhaustive)}`)
		}
	}
}

function pendingChanges(
	reason: PackageApprovalReason,
	details: Record<string, unknown>,
): Array<string> {
	switch (reason) {
		case 'credential_needs_changed':
			return readCredentialNeedChanges(details).map(
				describeCredentialNeedChange,
			)
		case 'went_public':
			return [readWentPublicSummary(details)]
		default: {
			const exhaustive: never = reason
			throw new Error(`Unknown approval reason: ${String(exhaustive)}`)
		}
	}
}

/**
 * Pending requests the approval page shows. A request whose base is no
 * longer the published commit is stale (a later publish replaced it), so it
 * is left out.
 */
export async function loadPendingPackageApprovals(input: {
	env: Env
	ownerUserId: string
	packageId: string
	publishedCommit: string | null
}): Promise<Array<AccountPackagePendingApproval>> {
	const pending = await listPendingPackageApprovalRequests(input.env.APP_DB, {
		packageId: input.packageId,
		ownerUserId: input.ownerUserId,
	})
	return pending
		.filter((request) => request.baseCommit === input.publishedCommit)
		.map((request) => ({
			id: request.id,
			reason: request.reason,
			reasonLabel: reasonLabel(request.reason),
			pendingCommit: request.pendingCommit,
			createdAt: request.createdAt,
			changes: pendingChanges(request.reason, request.details),
			approveAction: approveAction(request.reason),
		}))
}

export type ApproveCredentialNeedsResult =
	| { ok: true }
	| { ok: false; status: 400 | 404 | 409; error: string }

/**
 * Publishes a paused commit whose credential needs changed. The click
 * (`package:publish`) is the owner's approval of that exact commit, so it also
 * counts as the locked-publish approval (`package:write`); checks and the
 * fast-forward rules still apply.
 */
export async function approveCredentialNeedsRequest(input: {
	env: Env
	request: Request
	savedPackage: SavedPackageRecord
	ownerUserId: string
	actorUserId: string
	requestId: string
}): Promise<ApproveCredentialNeedsResult> {
	const approval = await getPackageApprovalRequest(input.env.APP_DB, {
		id: input.requestId,
		packageId: input.savedPackage.id,
		ownerUserId: input.ownerUserId,
	})
	if (!approval || approval.reason !== 'credential_needs_changed') {
		return { ok: false, status: 404, error: 'Approval request not found.' }
	}
	if (approval.status !== 'pending') {
		return {
			ok: false,
			status: 409,
			error: 'This request was already resolved. Reload the page.',
		}
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.savedPackage.sourceId,
	)
	if (!source || source.user_id !== input.ownerUserId) {
		return { ok: false, status: 404, error: 'Package source not found.' }
	}
	const supersede = async () => {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: approval.id,
			status: 'superseded',
			resolvedByUserId: input.actorUserId,
		})
		return {
			ok: false as const,
			status: 409 as const,
			error:
				'The published version changed since this publish was paused. Publish again to request approval.',
		}
	}
	if (source.published_commit !== approval.baseCommit) return await supersede()
	const approved = async () => {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: approval.id,
			status: 'approved',
			resolvedByUserId: input.actorUserId,
		})
		return { ok: true as const }
	}
	const sessionGone = async () => {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: approval.id,
			status: 'superseded',
			resolvedByUserId: input.actorUserId,
		})
		return {
			ok: false as const,
			status: 409 as const,
			error:
				'This paused publish is no longer available. Publish again to request approval.',
		}
	}
	const pausedSession = readPausedSessionPublish(approval.details)
	if (pausedSession) {
		const sessionRow = await getRepoSessionById(input.env, {
			userId: ownerIdFromStored(input.ownerUserId),
			sessionId: pausedSession.sessionId,
		})
		if (!sessionRow) return await sessionGone()
		let sessionResult: RepoSessionPublishResult
		try {
			sessionResult = await repoSessionRpc(
				input.env,
				pausedSession.sessionId,
			).publishSession({
				sessionId: pausedSession.sessionId,
				userId: input.ownerUserId,
				force: pausedSession.force,
				destructiveOverwriteConfirmed:
					pausedSession.destructiveOverwriteConfirmed,
				privateVisibilityChangeConfirmed:
					pausedSession.privateVisibilityChangeConfirmed,
				...(pausedSession.expectedPackageScope !== undefined
					? { expectedPackageScope: pausedSession.expectedPackageScope }
					: {}),
				allowLockedPublish: true,
				credentialNeedsApproved: true,
				expectedHeadCommit: approval.pendingCommit,
				rebuildPackageArtifacts: true,
			})
		} catch (error) {
			// Other failures may be transient, so the request stays pending.
			if (isPausedSessionMovedError(error)) return await sessionGone()
			throw error
		}
		switch (sessionResult.status) {
			case 'ok':
				return await approved()
			case 'base_moved':
			case 'checks_outdated':
				return await supersede()
			case 'locked':
			case 'approval_required':
				return { ok: false, status: 409, error: sessionResult.message }
			default: {
				const exhaustive: never = sessionResult
				throw new Error(`Unknown publish status: ${String(exhaustive)}`)
			}
		}
	}
	const sessionId = `approve-credential-needs-${input.savedPackage.id}`
	let result: RepoExternalPublishResult
	try {
		result = await repoSessionRpc(input.env, sessionId).publishFromExternalRef({
			sessionId,
			sourceId: source.id,
			userId: input.ownerUserId,
			newCommit: approval.pendingCommit,
			// A newer push replaces this request; never publish an older commit
			// over it.
			expectedHead: approval.pendingCommit,
			...readPausedExternalPublish(approval.details),
			allowLockedPublish: true,
			credentialNeedsApproved: true,
			baseUrl: getAppBaseUrl({
				env: input.env,
				requestUrl: input.request.url,
			}),
			rebuildPackageArtifacts: true,
		})
	} catch (error) {
		if (getErrorMessage(error).includes('Artifacts HEAD changed from')) {
			return await supersede()
		}
		throw error
	}
	switch (result.status) {
		case 'published':
		case 'already_published':
			return await approved()
		case 'not_fast_forward':
			return await supersede()
		case 'checks_failed':
			return {
				ok: false,
				status: 400,
				error:
					'Publish checks failed for this commit. Fix the package and publish again.',
			}
		case 'locked':
		case 'approval_required':
			return { ok: false, status: 409, error: result.message }
		default: {
			const exhaustive: never = result
			throw new Error(`Unknown publish status: ${String(exhaustive)}`)
		}
	}
}

export type ApproveWentPublicResult =
	| { ok: true }
	| { ok: false; status: 400 | 404 | 409; error: string }

/**
 * Flips internet-visible on for a pending `went_public` request. Capability
 * approval must still match the live set; the storage-change re-prompt stays
 * on the fingerprint path.
 */
export async function approveWentPublicRequest(input: {
	env: Env
	request: Request
	savedPackage: SavedPackageRecord
	ownerUserId: string
	actorUserId: string
	requestId: string
}): Promise<ApproveWentPublicResult> {
	const approval = await getPackageApprovalRequest(input.env.APP_DB, {
		id: input.requestId,
		packageId: input.savedPackage.id,
		ownerUserId: input.ownerUserId,
	})
	if (!approval || approval.reason !== 'went_public') {
		return { ok: false, status: 404, error: 'Approval request not found.' }
	}
	if (approval.status !== 'pending') {
		return {
			ok: false,
			status: 409,
			error: 'This request was already resolved. Reload the page.',
		}
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.savedPackage.sourceId,
	)
	if (!source || source.user_id !== input.ownerUserId) {
		return { ok: false, status: 404, error: 'Package source not found.' }
	}
	if (source.published_commit !== approval.baseCommit) {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: approval.id,
			status: 'superseded',
			resolvedByUserId: input.actorUserId,
		})
		return {
			ok: false,
			status: 409,
			error:
				'The published version changed since this request was created. Approve the capability set again.',
		}
	}
	if (input.savedPackage.isInternetVisible) {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: approval.id,
			status: 'approved',
			resolvedByUserId: input.actorUserId,
		})
		return { ok: true }
	}
	const summary = await loadCapabilityApprovalSummary({
		env: input.env,
		ownerUserId: input.ownerUserId as OwnerId,
		savedPackage: input.savedPackage,
		requestUrl: input.request.url,
	})
	if (!summary.fingerprintMatchesApproval) {
		return {
			ok: false,
			status: 409,
			error:
				'Review and approve the credential and capability summary before making this package internet-visible.',
		}
	}
	const changed = await updateSavedPackage(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.savedPackage.id,
		isInternetVisible: true,
	})
	if (!changed) {
		return { ok: false, status: 404, error: 'Package not found.' }
	}
	await resolvePackageApprovalRequest(input.env.APP_DB, {
		id: approval.id,
		status: 'approved',
		resolvedByUserId: input.actorUserId,
	})
	return { ok: true }
}
