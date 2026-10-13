import { expect, test } from 'vitest'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalView,
	type CredentialRef,
} from '#universal/credential-contracts.ts'
import {
	approvalAfterLabel,
	approvalBeforeLabel,
	approvalChangeIsNoop,
	approvalDoneCopy,
	approvalEnableStatus,
	approvalProblems,
	approvalSummary,
	credentialApprovalAgentPrompt,
	credentialKindLabel,
	credentialRefLabel,
	describeTrigger,
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
		beforeUnusableIds: [],
		after: [bot],
		willEnable: false,
		error: null,
		...overrides,
	}
}

const daily = { kind: 'cron', name: 'daily' } as const

function enableEntry(
	overrides: Partial<CredentialApprovalEnableView> = {},
): CredentialApprovalEnableView {
	return {
		trigger: { kind: 'webhook', name: 'incoming' },
		willEnable: true,
		error: null,
		...overrides,
	}
}

function view(
	changes: Array<CredentialApprovalChangeView>,
	enable: Array<CredentialApprovalEnableView> = [],
): CredentialApprovalView {
	return {
		ok: true,
		package: { id: 'pkg', kodyId: 'digest' },
		reason: null,
		canApprove: true,
		fingerprint: 'fp',
		changes,
		enable,
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

test('labels name triggers, credential refs, and kinds', () => {
	expect(describeTrigger(daily)).toBe('Schedule “daily”')
	expect(describeTrigger({ kind: 'webhook', name: 'incoming' })).toBe(
		'Webhook “incoming”',
	)
	expect(describeTrigger({ kind: 'subscription', name: 'topic' })).toBe(
		'Subscription “topic”',
	)
	expect(credentialRefLabel(bot)).toBe('acme-bot')
	expect(credentialRefLabel(mine)).toBe('openai (yours)')
	expect(
		(['secret', 'oauth', 'mcp', 'url', 'login', 'signing'] as const).map(
			credentialKindLabel,
		),
	).toEqual(['Key', 'OAuth', 'MCP server', 'URL', 'Login', 'Signing'])
})

test('an enable-only link names the trigger it turns on', () => {
	expect(approvalSummary(view([], [enableEntry()]))).toBe(
		'Approve and turn on Webhook “incoming”',
	)
	expect(
		approvalSummary(
			view(
				[],
				[
					enableEntry(),
					enableEntry({ trigger: { kind: 'subscription', name: 'topic' } }),
				],
			),
		),
	).toBe('Approve and turn on Webhook “incoming”, Subscription “topic”')
	expect(approvalSummary(view([], [enableEntry({ willEnable: false })]))).toBe(
		'Approve',
	)
})

test('mappings and enable[] combine without repeating a trigger', () => {
	expect(
		approvalSummary(
			view(
				[
					change({
						target: { type: 'trigger', trigger: daily },
						willEnable: true,
					}),
				],
				[enableEntry(), enableEntry({ trigger: daily })],
			),
		),
	).toBe('Approve 1 mapping and turn on Schedule “daily”, Webhook “incoming”')
	expect(approvalSummary(view([change({})], [enableEntry()]))).toBe(
		'Approve 1 mapping and turn on Webhook “incoming”',
	)
})

test('the approved line names what the reviewed view turned on', () => {
	expect(approvalDoneCopy(view([], [enableEntry()]))).toBe(
		'Webhook “incoming” is on.',
	)
	expect(
		approvalDoneCopy(
			view(
				[
					change({
						target: { type: 'trigger', trigger: daily },
						willEnable: true,
					}),
				],
				[enableEntry()],
			),
		),
	).toBe('1 mapping is saved and Schedule “daily”, Webhook “incoming” are on.')
	expect(approvalDoneCopy(view([], [enableEntry({ willEnable: false })]))).toBe(
		'Nothing needed to change.',
	)
})

test('an enable entry reads on, turning on, already on, or only its error', () => {
	const pending = { approved: false, turnedOn: false }
	expect(approvalEnableStatus(enableEntry(), pending)).toBe(
		'Approving turns on Webhook “incoming” for you.',
	)
	expect(
		approvalEnableStatus(enableEntry({ willEnable: false }), pending),
	).toBe('Webhook “incoming” is already on for you.')
	const failed = enableEntry({
		willEnable: false,
		error: { code: 'webhook_other_enabler', message: 'Someone else runs it.' },
	})
	expect(approvalEnableStatus(failed, pending)).toBeNull()
	expect(
		approvalEnableStatus(enableEntry({ willEnable: false }), {
			approved: true,
			turnedOn: true,
		}),
	).toBe('Webhook “incoming” is on for you.')
	expect(
		approvalEnableStatus(enableEntry({ willEnable: false }), {
			approved: true,
			turnedOn: false,
		}),
	).toBe('Webhook “incoming” is already on for you.')
})

test('enable errors are problems too', () => {
	const broken = view(
		[],
		[
			enableEntry({
				error: {
					code: 'webhook_not_minted',
					message: 'Mint this webhook first.',
				},
			}),
		],
	)
	expect(approvalProblems(broken)).toEqual([
		'Webhook “incoming”: Mint this webhook first.',
	])
})
