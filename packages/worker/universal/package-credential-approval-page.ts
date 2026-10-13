/**
 * The credential approval page (`/@user/kody-id/approve-credentials?<proposal>`)
 * on top of the approval API (docs/contributing/contracts/credential-mappings-api.md):
 * the page payload, how changes group, and the copy each one shows. Nothing
 * here carries a credential value.
 */
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalView,
	type CredentialMappingTarget,
	type CredentialRef,
	type CredentialTriggerRef,
} from '#universal/credential-contracts.ts'
import {
	credentialRefLabel,
	describeTrigger,
} from '#universal/package-credentials-page.ts'

/** Not found also covers a viewer without `package:execute`, as the API does. */
export type PackageCredentialApprovalLoaderData =
	| { ok: true; view: CredentialApprovalView }
	| { ok: false; notFound: true }

export type CredentialApprovalGroup = {
	key: string
	title: string
	description: string
	trigger: CredentialTriggerRef | null
	changes: Array<{ index: number; change: CredentialApprovalChangeView }>
}

function groupFor(
	target: CredentialMappingTarget,
): Omit<CredentialApprovalGroup, 'changes'> {
	switch (target.type) {
		case 'default':
			return target.layer === 'org'
				? {
						key: 'default:org',
						title: 'Org defaults',
						description:
							'What everyone in the org uses when they run this package, unless they set their own.',
						trigger: null,
					}
				: {
						key: 'default:mine',
						title: 'Your defaults',
						description: 'What your own runs of this package use.',
						trigger: null,
					}
		case 'trigger':
			return {
				key: `trigger:${JSON.stringify([target.trigger.kind, target.trigger.name])}`,
				title: describeTrigger(target.trigger),
				description: 'What this trigger uses when it runs as you.',
				trigger: target.trigger,
			}
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

/** Org defaults, then your defaults, then each trigger in the order the proposal names it. */
export function groupApprovalChanges(
	changes: ReadonlyArray<CredentialApprovalChangeView>,
): Array<CredentialApprovalGroup> {
	const groups = new Map<string, CredentialApprovalGroup>()
	changes.forEach((change, index) => {
		const group = groupFor(change.target)
		const existing = groups.get(group.key) ?? { ...group, changes: [] }
		existing.changes.push({ index, change })
		groups.set(group.key, existing)
	})
	const rank = (group: CredentialApprovalGroup) =>
		group.key === 'default:org' ? 0 : group.key === 'default:mine' ? 1 : 2
	return [...groups.values()].sort((a, b) => rank(a) - rank(b))
}

function refsLabel(refs: ReadonlyArray<CredentialRef>) {
	return refs.map(credentialRefLabel).join(', ')
}

/** The stored mapping today: `null` inherits, `[]` is none on purpose. */
export function approvalBeforeLabel(change: CredentialApprovalChangeView) {
	if (change.before === null) {
		return change.target.type === 'trigger'
			? 'Inherits your default'
			: 'Not set'
	}
	if (change.before.length === 0) return 'None on purpose'
	return refsLabel(change.before)
}

export function approvalAfterLabel(change: CredentialApprovalChangeView) {
	if (change.after.length === 0)
		return 'None on purpose (runs get no credential)'
	return refsLabel(change.after)
}

export function approvalChangeIsNoop(change: CredentialApprovalChangeView) {
	if (change.before === null) return false
	const before = change.before.map((ref) => ref.id)
	const after = change.after.map((ref) => ref.id)
	return (
		before.length === after.length &&
		before.every((id, index) => id === after[index])
	)
}

/** Every problem on the page, for the agent prompt and the summary. */
export function approvalProblems(view: CredentialApprovalView): Array<string> {
	return [
		...view.errors,
		...view.changes.flatMap((change) =>
			change.error ? [`${change.needKey}: ${change.error.message}`] : [],
		),
	]
}

export function approvalSummary(view: CredentialApprovalView) {
	const count = view.changes.length
	const enables = new Set(
		view.changes
			.filter((change) => change.willEnable && change.target.type === 'trigger')
			.map((change) =>
				change.target.type === 'trigger'
					? describeTrigger(change.target.trigger)
					: '',
			),
	)
	const mappings = count === 1 ? '1 mapping' : `${count} mappings`
	if (enables.size === 0) return `Approve ${mappings}`
	return `Approve ${mappings} and turn on ${[...enables].join(', ')}`
}

export function credentialApprovalAgentPrompt(input: {
	pageUrl: string
	problems: ReadonlyArray<string>
}) {
	return [
		`I opened a credential approval link on Kody: ${input.pageUrl}`,
		'Kody said:',
		...input.problems.map((problem) => `- ${problem}`),
		'Build a corrected link (credentialMappingPropose checks it first). Do not ask me to paste any credential value into chat.',
	].join('\n')
}
