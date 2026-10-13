import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	describeCredentialNeedChange,
	readCredentialNeedChanges,
} from '#worker/credentials/credential-needs-approval.ts'
import {
	getPackageApprovalRequest,
	listPendingPackageApprovalRequests,
	resolvePackageApprovalRequest,
	type PackageApprovalReason,
} from '#worker/package-capabilities/approval-requests-repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
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
			return null
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
			changes:
				request.reason === 'credential_needs_changed'
					? readCredentialNeedChanges(request.details).map(
							describeCredentialNeedChange,
						)
					: [],
			approveAction: approveAction(request.reason),
		}))
}

export type ApproveCredentialNeedsResult =
	| { ok: true }
	| { ok: false; status: 400 | 404 | 409; error: string }

/**
 * Publishes a paused commit whose credential needs changed. The click is the
 * owner's approval; every other publish gate (checks, lock, fast-forward)
 * still applies.
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
	const sessionId = `approve-credential-needs-${input.savedPackage.id}`
	const result = await repoSessionRpc(
		input.env,
		sessionId,
	).publishFromExternalRef({
		sessionId,
		sourceId: source.id,
		userId: input.ownerUserId,
		newCommit: approval.pendingCommit,
		credentialNeedsApproved: true,
		// A packageSave with confirm_destructive_overwrite pauses a commit that
		// replaced history, so it is not a fast-forward of the base. The base
		// check above already proved nothing published since the pause.
		allowForce: true,
		destructiveOverwriteConfirmed: true,
		baseUrl: getAppBaseUrl({ env: input.env, requestUrl: input.request.url }),
		rebuildPackageArtifacts: true,
	})
	switch (result.status) {
		case 'published':
		case 'already_published':
			await resolvePackageApprovalRequest(input.env.APP_DB, {
				id: approval.id,
				status: 'approved',
				resolvedByUserId: input.actorUserId,
			})
			return { ok: true }
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
			return {
				ok: false,
				status: 409,
				error:
					'This package is locked. Unlock it, or approve the publish from its locked-publish approval page.',
			}
		case 'approval_required':
			return { ok: false, status: 409, error: result.message }
		default: {
			const exhaustive: never = result
			throw new Error(`Unknown publish status: ${String(exhaustive)}`)
		}
	}
}
