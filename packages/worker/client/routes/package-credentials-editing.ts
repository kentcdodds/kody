import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type CredentialMappingChange,
	type CredentialMappingTarget,
	type CredentialRef,
	type PackageCredentialNeedView,
	type PackageCredentialsEnablementAction,
	type PackageCredentialsView,
	type PackageCredentialsWriteError,
	type PackageCredentialsWriteFailure,
	type PackageTriggerView,
	type StoredCredentialMapping,
} from '#universal/credential-contracts.ts'
import { describeTrigger } from '#universal/package-credentials-page.ts'
import { routes } from '#universal/routes.ts'

/** What the editor will write: inherit (`null`), none on purpose (`[]`), or picks. */
export type MappingDraft =
	| { mode: 'inherit' }
	| { mode: 'none' }
	| { mode: 'pick'; ids: Array<string> }

export function mappingEditorKey(
	target: CredentialMappingTarget,
	needKey: string,
) {
	switch (target.type) {
		case 'default':
			return JSON.stringify(['default', target.layer, needKey])
		case 'trigger':
			return JSON.stringify([
				'trigger',
				target.trigger.kind,
				target.trigger.name,
				target.enablementId ?? '',
				target.createInstance ? 'new' : '',
				needKey,
			])
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

export function draftFromStored(
	stored: StoredCredentialMapping | null,
): MappingDraft {
	if (!stored) return { mode: 'inherit' }
	if (stored.credentials.length === 0) {
		return stored.unusableIds.length === 0
			? { mode: 'none' }
			: { mode: 'pick', ids: [] }
	}
	return { mode: 'pick', ids: stored.credentials.map((ref) => ref.id) }
}

/** The org default can only point at org credentials; other targets take any option. */
export function mappingOptions(
	need: PackageCredentialNeedView,
	target: CredentialMappingTarget,
): Array<CredentialRef> {
	return target.type === 'default' && target.layer === 'org'
		? need.options.filter((option) => option.scope === 'org')
		: need.options
}

export function toggleDraftPick(
	draft: MappingDraft,
	id: string,
	input: { multiple: boolean; checked: boolean },
): MappingDraft {
	if (!input.multiple) return { mode: 'pick', ids: [id] }
	const ids = draft.mode === 'pick' ? draft.ids : []
	const next = input.checked
		? [...ids.filter((existing) => existing !== id), id]
		: ids.filter((existing) => existing !== id)
	return { mode: 'pick', ids: next }
}

export function draftToChange(input: {
	target: CredentialMappingTarget
	need: PackageCredentialNeedView
	draft: MappingDraft
}):
	| { ok: true; change: CredentialMappingChange }
	| { ok: false; error: string } {
	const base = { target: input.target, needKey: input.need.key }
	switch (input.draft.mode) {
		case 'inherit':
			return { ok: true, change: { ...base, credentials: null } }
		case 'none':
			return { ok: true, change: { ...base, credentials: [] } }
		case 'pick': {
			const ids = input.draft.ids
			if (ids.length === 0) {
				return {
					ok: false,
					error: 'Pick a credential, or choose none on purpose.',
				}
			}
			if (ids.length > 1 && !input.need.multiple) {
				return {
					ok: false,
					error: `“${input.need.key}” takes one credential.`,
				}
			}
			return {
				ok: true,
				change: { ...base, credentials: ids.map((id) => ({ id })) },
			}
		}
		default: {
			const exhaustive: never = input.draft
			return exhaustive
		}
	}
}

/**
 * Writing a credential choice turns the trigger on for a writer who has not
 * enabled it, or creates another instance when `createInstance` is set.
 * Inherit writes nothing, so an off trigger stays off.
 */
export function triggerWillEnable(
	trigger: PackageTriggerView,
	draft: MappingDraft,
	target?: CredentialMappingTarget,
) {
	if (!trigger.canEdit || draft.mode === 'inherit') return false
	if (target?.type === 'trigger' && target.createInstance) return true
	return trigger.enablement === null
}

/** Why saving this draft would change nothing, or null when it writes. */
export function triggerDraftProblem(
	trigger: PackageTriggerView | null,
	draft: MappingDraft,
) {
	if (!trigger || trigger.enablement !== null || draft.mode !== 'inherit') {
		return null
	}
	return 'This trigger is off, and inheriting writes nothing, so it would stay off. Pick a credential (or none on purpose) to turn it on with this mapping.'
}

export function canEditTrigger(trigger: PackageTriggerView) {
	if (!trigger.canEdit) return false
	if (trigger.enablement && !trigger.enablement.enabledByYou) return false
	return !(trigger.trigger.kind === 'webhook' && trigger.instanceId === null)
}

/**
 * One row per declared need, using the trigger's own row when the API sent
 * one. A trigger nobody has turned on yet may come back without rows.
 */
export function triggerMappingRows(
	view: PackageCredentialsView,
	trigger: PackageTriggerView,
): Array<{
	need: PackageCredentialNeedView
	mapping: PackageTriggerView['mappings'][number] | null
}> {
	const byKey = new Map(
		trigger.mappings.map((mapping) => [mapping.needKey, mapping]),
	)
	return view.needs.map((need) => ({
		need,
		mapping: byKey.get(need.key) ?? null,
	}))
}

export type PackageCredentialsWriteResult =
	| { kind: 'saved'; view: PackageCredentialsView }
	| { kind: 'refused'; errors: Array<PackageCredentialsWriteError> }
	| { kind: 'error'; message: string }
	| { kind: 'unauthorized' }

export async function postPackageCredentialChanges(input: {
	username: string
	kodyId: string
	changes?: Array<CredentialMappingChange>
	enablements?: Array<PackageCredentialsEnablementAction>
}): Promise<PackageCredentialsWriteResult> {
	const body: {
		changes?: Array<CredentialMappingChange>
		enablements?: Array<PackageCredentialsEnablementAction>
	} = {}
	if (input.changes && input.changes.length > 0) body.changes = input.changes
	if (input.enablements && input.enablements.length > 0) {
		body.enablements = input.enablements
	}
	let response: Response
	try {
		response = await fetch(
			routes.communityPackageCredentialsApiPost.href({
				username: input.username,
				kodyId: input.kodyId,
			}),
			{
				method: 'POST',
				credentials: 'include',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			},
		)
	} catch {
		return { kind: 'error', message: 'Kody could not be reached. Try again.' }
	}
	if (response.status === 401) return { kind: 'unauthorized' }
	const payload = await readJson<
		| PackageCredentialsView
		| PackageCredentialsWriteFailure
		| { ok: false; error?: string }
	>(response)
	if (response.ok && payload?.ok) return { kind: 'saved', view: payload }
	if (payload && !payload.ok && 'errors' in payload && payload.errors.length) {
		return { kind: 'refused', errors: payload.errors }
	}
	const message =
		payload && !payload.ok && 'error' in payload ? payload.error : null
	return {
		kind: 'error',
		message:
			message ||
			(response.status === 409
				? 'Someone else turned this trigger on while you were editing. Reload to see their mapping.'
				: `Kody could not save this mapping (HTTP ${response.status}).`),
	}
}

export function describeMappingTarget(target: CredentialMappingTarget) {
	switch (target.type) {
		case 'default':
			return target.layer === 'org' ? 'the org default' : 'your default'
		case 'trigger':
			return describeTrigger(target.trigger)
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

export function mappingSaveAgentPrompt(input: {
	pageUrl: string
	needKey: string
	target: CredentialMappingTarget
	message: string
}) {
	return [
		`I tried to map “${input.needKey}” for ${describeMappingTarget(input.target)} on Kody: ${input.pageUrl}`,
		`Kody said: ${input.message}`,
		'Help me fix it. Do not ask me to paste any credential value into chat.',
	].join('\n')
}
