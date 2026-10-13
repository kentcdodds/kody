/**
 * The approval page's view and Approve (contract: "Mapping proposals and the
 * approval page"). An agent only proposes mappings and triggers to turn on;
 * they take effect when a signed-in person approves exactly what they
 * reviewed. The fingerprint pins that: the changes resolved to credential ids
 * for this viewer, so a rename, a replaced credential, or a mapping edited
 * since review fails Approve.
 */
import {
	type CredentialApprovalView,
	type ParsedCredentialProposal,
} from '#universal/credential-contracts.ts'
import {
	MappingChangedSinceResolve,
	MappingWriteRefused,
	resolveMappingChanges,
	resolveTriggerEnables,
	writeMappingChanges,
	type ResolvedMappingChange,
	type ResolvedTriggerEnable,
} from './package-credential-mapping-changes.ts'
import {
	loadPackageMappingScope,
	type PackageMappingScope,
} from './package-credential-mappings.ts'

async function sha256Hex(text: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

function fingerprintOf(
	scope: PackageMappingScope,
	proposal: ParsedCredentialProposal,
	resolved: ReadonlyArray<ResolvedMappingChange>,
	enable: ReadonlyArray<ResolvedTriggerEnable>,
) {
	return sha256Hex(
		JSON.stringify({
			packageId: scope.savedPackage.id,
			actorId: scope.actorId,
			reason: proposal.reason,
			errors: proposal.errors,
			// Stored ids (usable or not) catch any edit since review; names
			// and scopes catch a rename of a credential picked by id.
			changes: resolved.map((change) => [
				change.target,
				change.needKey,
				change.beforeCredentialIds,
				change.before?.map((ref) => [ref.id, ref.name, ref.scope]) ?? null,
				change.after.map((ref) => [ref.id, ref.name, ref.scope]),
				change.willEnable,
				change.error?.code ?? null,
			]),
			enable: enable.map((entry) => [
				entry.trigger,
				entry.declared?.instanceId ?? null,
				entry.willEnable,
				entry.error?.code ?? null,
			]),
		}),
	)
}

export type ResolvedCredentialApproval = {
	view: CredentialApprovalView
	resolved: Array<ResolvedMappingChange>
	enable: Array<ResolvedTriggerEnable>
}

/** Resolves a proposal for the scope's viewer. Never writes. */
export async function resolveCredentialApproval(
	scope: PackageMappingScope,
	proposal: ParsedCredentialProposal,
): Promise<ResolvedCredentialApproval> {
	const resolved = await resolveMappingChanges(scope, proposal.changes)
	const enable = resolveTriggerEnables(scope, proposal.enable)
	return {
		resolved,
		enable,
		view: {
			ok: true,
			package: {
				id: scope.savedPackage.id,
				kodyId: scope.savedPackage.kodyId,
			},
			reason: proposal.reason,
			canApprove:
				proposal.errors.length === 0 &&
				resolved.length + enable.length > 0 &&
				resolved.every((change) => change.error === null) &&
				enable.every((entry) => entry.error === null),
			fingerprint: await fingerprintOf(scope, proposal, resolved, enable),
			changes: resolved.map((change) => ({
				target: change.target,
				needKey: change.needKey,
				need: change.need,
				before: change.before,
				beforeUnusableIds: change.beforeUnusableIds,
				after: change.after,
				willEnable: change.willEnable,
				error: change.error,
			})),
			enable: enable.map((entry) => ({
				trigger: entry.trigger,
				willEnable: entry.willEnable,
				error: entry.error,
			})),
			errors: proposal.errors,
		},
	}
}

export type CredentialApprovalOutcome =
	| { status: 'approved'; view: CredentialApprovalView }
	| { status: 'invalid'; view: CredentialApprovalView }
	| { status: 'stale'; view: CredentialApprovalView }
	| { status: 'conflict'; message: string; view: CredentialApprovalView }

async function resolveFresh(
	scope: PackageMappingScope,
	proposal: ParsedCredentialProposal,
) {
	const fresh = await loadPackageMappingScope({
		env: scope.env,
		baseUrl: scope.baseUrl,
		request: scope.request,
		savedPackage: scope.savedPackage,
		canManage: scope.canManage,
	})
	return (await resolveCredentialApproval(fresh, proposal)).view
}

/**
 * Re-resolves the proposal and, when it still matches `fingerprint` and has
 * no errors, writes every change (and any trigger it turns on) in one batch.
 * The returned view is resolved again after the write.
 */
export async function approveCredentialProposal(input: {
	scope: PackageMappingScope
	proposal: ParsedCredentialProposal
	fingerprint: string
}): Promise<CredentialApprovalOutcome> {
	const { scope, proposal } = input
	const current = await resolveCredentialApproval(scope, proposal)
	if (!current.view.canApprove) {
		return { status: 'invalid', view: current.view }
	}
	if (current.view.fingerprint !== input.fingerprint) {
		return { status: 'stale', view: current.view }
	}
	try {
		await writeMappingChanges(scope, current.resolved, {
			enable: current.enable,
			requireUnchanged: true,
		})
	} catch (error) {
		// Something changed between this resolve and the write.
		if (
			error instanceof MappingWriteRefused &&
			error.code === 'webhook_other_enabler'
		) {
			return {
				status: 'conflict',
				message: error.message,
				view: await resolveFresh(scope, proposal),
			}
		}
		if (
			error instanceof MappingWriteRefused ||
			error instanceof MappingChangedSinceResolve
		) {
			return { status: 'stale', view: await resolveFresh(scope, proposal) }
		}
		throw error
	}
	return { status: 'approved', view: await resolveFresh(scope, proposal) }
}
