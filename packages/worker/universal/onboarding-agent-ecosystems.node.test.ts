import { expect, test } from 'vitest'
import { mcpClientTabs } from './onboarding-mcp-clients.ts'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
	isOnboardingSameEcosystemAgent,
	listOnboardingGreyedSecondAgents,
	onboardingConnectedChooserKinds,
	onboardingGreyedSecondAgents,
	onboardingSecondAgentDisableReason,
	onboardingSecondAgentGreyedPresentation,
	onboardingStep3AgentIds,
	onboardingStep3EcosystemGroups,
	resolveOnboardingStep3SelectedAgent,
} from './onboarding-agent-ecosystems.ts'

test('ecosystems follow vendor families, with Cursor hosts on Grok', () => {
	expect(isOnboardingSameEcosystemAgent('codex', 'chatgpt')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('codex', 'cursor')).toBe(false)
	expect(isOnboardingSameEcosystemAgent('claude-code', 'claude-desktop')).toBe(
		true,
	)
	expect(isOnboardingSameEcosystemAgent('grok', 'grok-cli')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('grok', 'grok-bot')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('grok', 'cursor-local')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('grok-cli', 'cursor-cloud')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('copilot', 'copilot-app')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('cursor', 'grok-bot')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('cursor-local', 'cursor-cloud')).toBe(
		true,
	)
	expect(isOnboardingSameEcosystemAgent('cursor-cloud', 'grok-bot')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('other', 'cursor')).toBe(false)
	expect(onboardingGreyedSecondAgents()).toEqual([])

	const tabIds = new Set(mcpClientTabs.map((tab) => tab.id))
	for (const id of tabIds) {
		expect(isOnboardingSameEcosystemAgent(id, id)).toBe(id !== 'other')
	}
})

test('step 3 groups hosts by ecosystem and keeps Not listed', () => {
	expect(onboardingStep3EcosystemGroups.map((group) => group.id)).toEqual([
		'xai',
		'anthropic',
		'openai',
		'github',
		'google',
		'cognition',
		'sst',
		'openclaw',
		'other',
	])
	expect(onboardingStep3EcosystemGroups.map((group) => group.label)).toEqual([
		'Grok',
		'Claude',
		'ChatGPT',
		'GitHub',
		'Gemini',
		'Devin',
		'OpenCode',
		'OpenClaw',
		'Another host',
	])
	expect(onboardingStep3AgentIds()).toContain('cursor-local')
	expect(onboardingStep3AgentIds()).toContain('cursor-cloud')
	expect(onboardingStep3AgentIds()).toContain('grok-bot')
	expect(onboardingStep3AgentIds()).toContain('grok')
	expect(onboardingStep3AgentIds()).toContain('grok-cli')
	expect(onboardingStep3AgentIds()).not.toContain('cursor')
	const grok = onboardingStep3EcosystemGroups.find(
		(group) => group.id === 'xai',
	)
	expect(grok?.label).toBe('Grok')
	expect(grok?.agents).toEqual([
		'cursor-local',
		'cursor-cloud',
		'grok-bot',
		'grok',
		'grok-cli',
	])
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
		'other',
	)
	expect(resolveOnboardingStep3SelectedAgent('other')).toBe('other')
	expect(resolveOnboardingStep3SelectedAgent('cursor')).toBe('cursor')
})
