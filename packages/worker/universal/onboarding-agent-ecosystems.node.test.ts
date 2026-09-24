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
})

test('step 3 disables only known connections, and Cursor Cloud marks Grok Bot', () => {
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
	expect(greyed).toContainEqual({ id: 'cursor', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'claude-desktop', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'chatgpt', reason: 'connected' })
	expect(greyed).not.toContainEqual({
		id: 'claude-code',
		reason: 'connected',
	})
	expect(greyed).not.toContainEqual({ id: 'grok-bot', reason: 'connected' })
	expect(greyed).not.toContainEqual({
		id: 'cursor-local',
		reason: 'connected',
	})
	expect(greyed).not.toContainEqual({
		id: 'cursor-cloud',
		reason: 'connected',
	})
	expect(greyed.some((entry) => entry.id === 'other')).toBe(false)
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
	expect(presentation.greyedTitles['cursor-cloud']).toBe('Already connected.')
})

test('a second agent is a second ecosystem, not a second Cursor login', () => {
	expect(countConnectedAgentEcosystems([{ kind: 'cursor' }])).toBe(1)
	expect(
		countConnectedAgentEcosystems([
			{ kind: 'cursor' },
			{ kind: 'cursor-local' },
			{ kind: 'cursor-cloud' },
			{ kind: 'grok-bot' },
		]),
	).toBe(1)
	expect(
		hasSecondConnectedMcpClient([
			{ kind: 'cursor-local' },
			{ kind: 'cursor-cloud' },
		]),
	).toBe(false)
	expect(
		countConnectedAgentEcosystems([
			{ kind: 'cursor-cloud' },
			{ kind: 'grok-bot' },
			{ kind: 'grok' },
			{ kind: 'grok-cli' },
		]),
	).toBe(1)
	expect(
		hasSecondConnectedMcpClient([{ kind: 'cursor-local' }, { kind: 'grok' }]),
	).toBe(false)
	expect(
		hasSecondConnectedMcpClient([
			{ kind: 'cursor' },
			{ kind: null },
			{ kind: 'other' },
		]),
	).toBe(false)
	expect(hasSecondConnectedMcpClient([{ kind: null }, { kind: null }])).toBe(
		false,
	)
	expect(
		hasSecondConnectedMcpClient([
			{ kind: 'cursor-cloud' },
			{ kind: 'claude-code' },
		]),
	).toBe(true)
	expect(
		countConnectedAgentEcosystems([
			{ kind: 'codex' },
			{ kind: 'chatgpt' },
			{ kind: 'claude-desktop' },
		]),
	).toBe(2)
})

test('step 3 deep links drop known-connected hosts and keep the rest', () => {
	expect(resolveOnboardingStep3SelectedAgent('chatgpt')).toBe('chatgpt')
	expect(resolveOnboardingStep3SelectedAgent('codex')).toBe('codex')
	expect(resolveOnboardingStep3SelectedAgent('claude-code')).toBe('claude-code')
	expect(resolveOnboardingStep3SelectedAgent(null)).toBeNull()
	expect(
		resolveOnboardingStep3SelectedAgent('cursor-cloud', [
			{ kind: 'cursor-cloud' },
		]),
	).toBeNull()
	expect(
		resolveOnboardingStep3SelectedAgent('grok-bot', [{ kind: 'cursor-cloud' }]),
	).toBeNull()
	expect(
		resolveOnboardingStep3SelectedAgent('claude-code', [{ kind: 'cursor' }]),
	).toBe('claude-code')
	expect(
		resolveOnboardingStep3SelectedAgent('cursor-local', [{ kind: 'cursor' }]),
	).toBe('cursor-local')
	expect(resolveOnboardingStep3SelectedAgent('other', [{ kind: null }])).toBe(
		null,
	)
	expect(resolveOnboardingStep3SelectedAgent('other')).toBeNull()
	expect(resolveOnboardingStep3SelectedAgent('cursor')).toBe('cursor')
})
