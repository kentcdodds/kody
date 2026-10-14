/**
 * The approval page's view and Approve (contract: "Mapping proposals and the
 * approval page"). An agent only proposes mappings and triggers to turn on;
 * they take effect when a signed-in person approves exactly what they
 * reviewed. `credentialTriggerPickSet` writes through here too, and only a
 * trigger pick that agent proposed and the person approved (see
 * agent-credential-proposals.ts). The fingerprint pins that: the changes resolved to credential ids
 * for this viewer, so a rename, a replaced credential, or a mapping edited
 * since review fails Approve.
 */
import {
	isInboundEmailApprovalTopic,
	type CredentialApprovalView,
	type ParsedCredentialProposal,
} from '#universal/credential-contracts.ts'
import { planCredentialProposalApproval } from './agent-credential-proposals.ts'
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
			sender: proposal.sender,
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
	const resolved = await resolveMappingChanges(
		scope,
		proposal.changes,
		proposal.sender,
	)
	const enable = resolveTriggerEnables(scope, proposal.enable, proposal.sender)
	const errors = [...proposal.errors]
	const emailWithoutSender = emailTopicsTurningOn(resolved, enable)
	if (emailWithoutSender.length > 0 && !proposal.sender) {
		const listed = emailWithoutSender.map((topic) => `"${topic}"`).join(' and ')
		errors.push(
			`Turning on ${listed} needs a sender. Add sender_kind and sender_value (member, address, domain, or any_authenticated).`,
		)
	}
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
				errors.length === 0 &&
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
			sender: proposal.sender,
			errors,
		},
	}
}

function emailTopicsTurningOn(
	resolved: ReadonlyArray<ResolvedMappingChange>,
	enable: ReadonlyArray<ResolvedTriggerEnable>,
) {
	const topics = new Set<string>()
	for (const entry of enable) {
		if (
			entry.willEnable &&
			entry.trigger.kind === 'subscription' &&
			isInboundEmailApprovalTopic(entry.trigger.name)
		) {
			topics.add(entry.trigger.name)
		}
	}
	for (const change of resolved) {
		if (
			change.willEnable &&
			change.trigger?.kind === 'subscription' &&
			isInboundEmailApprovalTopic(change.trigger.name)
		) {
			topics.add(change.trigger.name)
		}
	}
	return [...topics]
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
 * With `proposalId`, the same batch records the trigger picks an agent's
 * proposal applied, which that agent may set again later. The returned view is
 * resolved again after the write.
 */
export async function approveCredentialProposal(input: {
	scope: PackageMappingScope
	proposal: ParsedCredentialProposal
	fingerprint: string
	proposalId?: string | null
}): Promise<CredentialApprovalOutcome> {
	const { scope, proposal } = input
	const current = await resolveCredentialApproval(scope, proposal)
	if (!current.view.canApprove) {
		return { status: 'invalid', view: current.view }
	}
	if (current.view.fingerprint !== input.fingerprint) {
		return { status: 'stale', view: current.view }
	}
	const approval = input.proposalId
		? await planCredentialProposalApproval({
				scope,
				proposalId: input.proposalId,
				proposal,
				resolved: current.resolved,
			})
		: null
	try {
		await writeMappingChanges(scope, current.resolved, {
			enable: current.enable,
			sender: proposal.sender,
			requireUnchanged: true,
			also: approval ? [approval] : [],
		})
	} catch (error) {
		// Something changed between this resolve and the write.
		if (
			error instanceof MappingWriteRefused &&
			(error.code === 'webhook_other_enabler' ||
				error.code === 'email_sender_conflict')
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
