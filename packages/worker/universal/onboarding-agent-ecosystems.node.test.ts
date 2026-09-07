import { expect, test } from 'vitest'
import {
	isOnboardingSameEcosystemAgent,
	listOnboardingGreyedSecondAgents,
	onboardingAgentEcosystem,
	onboardingConnectedChooserKinds,
	onboardingGreyedSecondAgents,
	onboardingSameEcosystemDisabledReason,
	onboardingSameEcosystemAgents,
	onboardingSecondAgentDisableHint,
	onboardingSecondAgentDisableReason,
	onboardingSecondAgentGreyedPresentation,
	resolveOnboardingStep3SelectedAgent,
} from './onboarding-agent-ecosystems.ts'

test('same-ecosystem greying follows vendor families, not agent kind', () => {
	expect(onboardingAgentEcosystem('codex')).toBe('openai')
	expect(onboardingSameEcosystemAgents('codex')).toEqual(['chatgpt', 'codex'])
	expect(onboardingGreyedSecondAgents('codex')).toEqual(['chatgpt', 'codex'])
	expect(isOnboardingSameEcosystemAgent('codex', 'chatgpt')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('codex', 'cursor')).toBe(false)
	expect(isOnboardingSameEcosystemAgent('codex', 'other')).toBe(false)

	expect(onboardingGreyedSecondAgents('claude-code')).toEqual([
		'claude-desktop',
		'claude-code',
	])
	expect(isOnboardingSameEcosystemAgent('claude-code', 'claude-desktop')).toBe(
		true,
	)

	expect(onboardingGreyedSecondAgents('cursor')).toEqual(['cursor'])
	expect(isOnboardingSameEcosystemAgent('cursor', 'grok-bot')).toBe(false)

	expect(onboardingGreyedSecondAgents('grok')).toEqual([
		'grok',
		'grok-cli',
		'grok-bot',
	])
	expect(onboardingGreyedSecondAgents('copilot')).toEqual([
		'copilot',
		'copilot-app',
	])

	expect(onboardingGreyedSecondAgents(null)).toEqual([])
	expect(onboardingGreyedSecondAgents('other')).toEqual(['other'])
	expect(isOnboardingSameEcosystemAgent('other', 'chatgpt')).toBe(false)

	expect(onboardingSameEcosystemDisabledReason('codex', 'Codex')).toContain(
		'Same ecosystem as Codex',
	)
	expect(onboardingSameEcosystemDisabledReason('cursor', 'Cursor')).toContain(
		'You started with Cursor',
	)
})

test('step 3 greys every connected named host and keeps Not listed', () => {
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

	const greyed = listOnboardingGreyedSecondAgents('gemini', connected)
	expect(greyed).toContainEqual({ id: 'gemini', reason: 'same-ecosystem' })
	expect(greyed).toContainEqual({ id: 'cursor', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'claude-desktop', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'chatgpt', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'devin', reason: 'connected' })
	expect(greyed).toContainEqual({ id: 'copilot', reason: 'connected' })
	expect(greyed.some((entry) => entry.id === 'other')).toBe(false)
	expect(greyed.some((entry) => entry.id === 'claude-code')).toBe(false)
	expect(greyed.some((entry) => entry.id === 'grok-bot')).toBe(false)
	expect(
		onboardingSecondAgentDisableReason('gemini', 'gemini', connected),
	).toBe('same-ecosystem')
	expect(
		onboardingSecondAgentDisableReason('cursor', 'gemini', connected),
	).toBe('connected')
	expect(
		onboardingSecondAgentDisableReason('claude-code', 'gemini', connected),
	).toBeNull()
	expect(onboardingSecondAgentDisableHint('connected')).toBe('Connected')

	const openaiOverlap = listOnboardingGreyedSecondAgents('codex', [
		{ kind: 'chatgpt' },
		{ kind: 'cursor' },
	])
	expect(openaiOverlap).toEqual([
		{ id: 'chatgpt', reason: 'same-ecosystem' },
		{ id: 'codex', reason: 'same-ecosystem' },
		{ id: 'cursor', reason: 'connected' },
	])

	const presentation = onboardingSecondAgentGreyedPresentation(
		'codex',
		'Codex',
		[{ kind: 'cursor' }],
	)
	expect(presentation.greyedAgents).toEqual(['chatgpt', 'codex', 'cursor'])
	expect(presentation.greyedReasons.cursor).toBe('connected')
	expect(presentation.greyedTitles.cursor).toContain('Already connected')
	expect(presentation.greyedTitles.chatgpt).toContain('Same ecosystem as Codex')
})

test('step 3 deep links drop greyed hosts and keep a different one', () => {
	expect(resolveOnboardingStep3SelectedAgent('codex', 'chatgpt')).toBeNull()
	expect(resolveOnboardingStep3SelectedAgent('codex', 'codex')).toBeNull()
	expect(resolveOnboardingStep3SelectedAgent('codex', 'claude-code')).toBe(
		'claude-code',
	)
	expect(resolveOnboardingStep3SelectedAgent(null, 'chatgpt')).toBe('chatgpt')
	expect(resolveOnboardingStep3SelectedAgent('codex', null)).toBeNull()
	expect(
		resolveOnboardingStep3SelectedAgent('gemini', 'cursor', [
			{ kind: 'cursor' },
		]),
	).toBeNull()
	expect(
		resolveOnboardingStep3SelectedAgent('gemini', 'claude-code', [
			{ kind: 'cursor' },
		]),
	).toBe('claude-code')
	expect(
		resolveOnboardingStep3SelectedAgent(null, 'other', [{ kind: null }]),
	).toBe('other')
})
