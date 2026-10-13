import { expect, test } from 'vitest'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalView,
	type CredentialRef,
} from '#universal/credential-contracts.ts'
import {
	approvalAfterLabel,
	approvalBeforeLabel,
	approvalChangeIsNoop,
	approvalProblems,
	approvalSummary,
	credentialApprovalAgentPrompt,
	groupApprovalChanges,
} from './package-credential-approval-page.ts'

const bot: CredentialRef = {
	id: 'cred-1',
	name: 'acme-bot',
	scope: 'org',
	kind: 'oauth',
}
const mine: CredentialRef = {
	id: 'cred-2',
	name: 'openai',
	scope: 'personal',
	kind: 'secret',
}

function change(
	overrides: Partial<CredentialApprovalChangeView>,
): CredentialApprovalChangeView {
	return {
		target: { type: 'default', layer: 'org' },
		needKey: 'github',
		need: null,
		before: null,
		after: [bot],
		willEnable: false,
		error: null,
		...overrides,
	}
}

const daily = { kind: 'cron', name: 'daily' } as const

function view(
	changes: Array<CredentialApprovalChangeView>,
): CredentialApprovalView {
	return {
		ok: true,
		package: { id: 'pkg', kodyId: 'digest' },
		reason: null,
		canApprove: true,
		fingerprint: 'fp',
		changes,
		errors: [],
	}
}

test('changes group as org defaults, your defaults, then each trigger', () => {
	const groups = groupApprovalChanges([
		change({ target: { type: 'trigger', trigger: daily }, needKey: 'slack' }),
		change({ target: { type: 'default', layer: 'mine' }, needKey: 'openai' }),
		change({ needKey: 'github' }),
		change({ target: { type: 'trigger', trigger: daily }, needKey: 'openai' }),
		change({
			target: { type: 'trigger', trigger: { kind: 'webhook', name: 'daily' } },
		}),
	])
	expect(
		groups.map((group) => [
			group.title,
			group.changes.map(({ index }) => index),
		]),
	).toEqual([
		['Org defaults', [2]],
		['Your defaults', [1]],
		['Schedule “daily”', [0, 3]],
		['Webhook “daily”', [4]],
	])
})

test('before and after read inherit, none, and credentials', () => {
	expect(approvalBeforeLabel(change({}))).toBe('Not set')
	expect(
		approvalBeforeLabel(
			change({ target: { type: 'trigger', trigger: daily } }),
		),
	).toBe('Inherits your default')
	expect(approvalBeforeLabel(change({ before: [] }))).toBe('None on purpose')
	expect(approvalBeforeLabel(change({ before: [bot, mine] }))).toBe(
		'acme-bot, openai (yours)',
	)
	expect(approvalAfterLabel(change({ after: [] }))).toBe(
		'None on purpose (runs get no credential)',
	)
	expect(approvalChangeIsNoop(change({ before: [bot] }))).toBe(true)
	expect(approvalChangeIsNoop(change({ before: null }))).toBe(false)
	expect(approvalChangeIsNoop(change({ before: [mine] }))).toBe(false)
	expect(
		approvalChangeIsNoop(change({ before: [bot, mine], after: [mine, bot] })),
	).toBe(false)
})

test('the approve button names the mappings and each trigger it turns on', () => {
	expect(approvalSummary(view([change({})]))).toBe('Approve 1 mapping')
	expect(
		approvalSummary(
			view([
				change({}),
				change({
					target: { type: 'trigger', trigger: daily },
					willEnable: true,
				}),
				change({
					target: { type: 'trigger', trigger: daily },
					needKey: 'slack',
					willEnable: true,
				}),
			]),
		),
	).toBe('Approve 3 mappings and turn on Schedule “daily”')
})

test('problems and the agent prompt list link and change errors', () => {
	const broken = {
		...view([
			change({
				error: { code: 'credential_not_found', message: 'No such credential.' },
			}),
		]),
		errors: ['"default[]" is missing a name.'],
	}
	const problems = approvalProblems(broken)
	expect(problems).toEqual([
		'"default[]" is missing a name.',
		'github: No such credential.',
	])
	expect(
		credentialApprovalAgentPrompt({
			pageUrl: 'https://kody.codes/@acme/digest/approve-credentials?x',
			problems,
		}),
	).toBe(
		[
			'I opened a credential approval link on Kody: https://kody.codes/@acme/digest/approve-credentials?x',
			'Kody said:',
			'- "default[]" is missing a name.',
			'- github: No such credential.',
			'Build a corrected link (credentialMappingPropose checks it first). Do not ask me to paste any credential value into chat.',
		].join('\n'),
	)
})
