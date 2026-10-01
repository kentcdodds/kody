import { expect, test } from 'vitest'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
	listOnboardingGreyedSecondAgents,
	onboardingConnectedChooserKinds,
	onboardingSecondAgentDisableReason,
	onboardingSecondAgentGreyedPresentation,
	onboardingStep3EcosystemGroups,
	resolveOnboardingStep3SelectedAgent,
} from './onboarding-agent-ecosystems.ts'

test('step 3 groups Cursor hosts with Grok and GitHub hosts together', () => {
	const github = onboardingStep3EcosystemGroups.find(
		(group) => group.id === 'github',
	)
	expect(github?.agents).toEqual(['copilot', 'copilot-app'])
	const grok = onboardingStep3EcosystemGroups.find(
		(group) => group.id === 'xai',
	)
	expect(grok?.agents).toEqual([
		'cursor-local',
		'cursor-cloud',
		'grok-bot',
		'grok',
		'grok-cli',
	])
	const muse = onboardingStep3EcosystemGroups.find(
		(group) => group.id === 'muse',
	)
	expect(muse?.agents).toEqual(['muse'])
	expect(onboardingStep3EcosystemGroups.map((group) => group.id)).toEqual(
		expect.arrayContaining(['wajo', 'cue', 'openmuse', 'openai']),
	)
	expect(
		onboardingStep3EcosystemGroups.find((group) => group.id === 'openmuse')
			?.agents,
	).toEqual(['openmuse'])
	expect(
		onboardingStep3EcosystemGroups.find((group) => group.id === 'openai')
			?.agents,
	).toEqual(['chatgpt', 'codex', 'dots'])
})

test('step 3 marks known connections, and Cursor Cloud marks Grok Bot', () => {
	const connected = [
		{ kind: 'cursor' as const },
		{ kind: 'claude-desktop' as const },
		{ kind: 'chatgpt' as const },
		{ kind: 'codex' as const },
		{ kind: 'devin' as const },
		{ kind: 'copilot' as const },
		{ kind: 'grok' as const },
		{ kind: 'grok-cli' as const },
		{ kind: null },
	]
	expect(onboardingConnectedChooserKinds(connected)).toEqual([
		'cursor',
		'claude-desktop',
		'chatgpt',
		'codex',
		'devin',
		'copilot',
		'grok',
		'grok-cli',
	])
	expect(onboardingConnectedChooserKinds([{ kind: 'other' }])).toEqual([])

	const greyed = listOnboardingGreyedSecondAgents(connected)
	const greyedIds = greyed.map((entry) => entry.id)
	expect(greyed).toEqual(
		expect.arrayContaining(
			['cursor', 'claude-desktop', 'chatgpt'].map((id) => ({
				id,
				reason: 'connected',
			})),
		),
	)
	for (const id of [
		'claude-code',
		'grok-bot',
		'cursor-local',
		'cursor-cloud',
		'other',
	]) {
		expect(greyedIds).not.toContain(id)
	}
	expect(
		onboardingSecondAgentDisableReason('claude-code', connected),
	).toBeNull()
	expect(onboardingSecondAgentDisableReason('chatgpt', connected)).toBe(
		'connected',
	)

	const cloud = listOnboardingGreyedSecondAgents([
		{ kind: 'cursor-cloud' },
		{ kind: 'cursor-local' },
	])
	expect(cloud).toEqual([
		{ id: 'cursor-cloud', reason: 'connected' },
		{ id: 'cursor-local', reason: 'connected' },
		{ id: 'grok-bot', reason: 'connected' },
	])

	const presentation = onboardingSecondAgentGreyedPresentation([
		{ kind: 'cursor-cloud' },
	])
	expect(presentation.greyedAgents).toEqual(['cursor-cloud', 'grok-bot'])
	expect(presentation.greyedReasons['grok-bot']).toBe('connected')
	expect(presentation.greyedTitles['grok-bot']).toContain('Cursor Cloud')
})

test('a second agent is a second ecosystem, not a second Cursor login', () => {
	type Kinds = Parameters<typeof countConnectedAgentEcosystems>[0]
	const kinds = (...list: Array<Kinds[number]['kind']>): Kinds =>
		list.map((kind) => ({ kind }))
	const ecosystems: Array<[Kinds, number]> = [
		[kinds('cursor'), 1],
		[kinds('cursor', 'cursor-local', 'cursor-cloud', 'grok-bot'), 1],
		[kinds('cursor-cloud', 'grok-bot', 'grok', 'grok-cli'), 1],
		[kinds('codex', 'chatgpt', 'claude-desktop'), 2],
	]
	expect(
		ecosystems.filter(
			([connected, want]) => countConnectedAgentEcosystems(connected) !== want,
		),
	).toEqual([])
	const second: Array<[Kinds, boolean]> = [
		[kinds('cursor-local', 'cursor-cloud'), false],
		[kinds('cursor-local', 'grok'), false],
		[kinds('cursor', null, 'other'), false],
		[kinds(null, null), false],
		[kinds('cursor-cloud', 'claude-code'), true],
	]
	expect(
		second.filter(
			([connected, want]) => hasSecondConnectedMcpClient(connected) !== want,
		),
	).toEqual([])
})

test('step 3 deep links drop Not listed and an empty selection', () => {
	expect(resolveOnboardingStep3SelectedAgent(null)).toBeNull()
	expect(resolveOnboardingStep3SelectedAgent('other')).toBeNull()
})
