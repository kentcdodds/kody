import { expect, test } from 'vitest'
import {
	isOnboardingSameEcosystemAgent,
	listOnboardingGreyedSecondAgents,
	onboardingConnectedChooserKinds,
	onboardingGreyedSecondAgents,
	onboardingSecondAgentDisableReason,
	onboardingSecondAgentGreyedPresentation,
	resolveOnboardingStep3SelectedAgent,
} from './onboarding-agent-ecosystems.ts'

test('same-ecosystem greying follows vendor families, not agent kind', () => {
	expect(isOnboardingSameEcosystemAgent('codex', 'chatgpt')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('codex', 'cursor')).toBe(false)
	expect(isOnboardingSameEcosystemAgent('claude-code', 'claude-desktop')).toBe(
		true,
	)
	expect(isOnboardingSameEcosystemAgent('grok', 'grok-bot')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('copilot', 'copilot-app')).toBe(true)
	expect(isOnboardingSameEcosystemAgent('cursor', 'grok-bot')).toBe(false)
	expect(onboardingGreyedSecondAgents(null)).toEqual([])
	expect(onboardingGreyedSecondAgents('other')).toEqual([])
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
	expect(resolveOnboardingStep3SelectedAgent('other', 'other')).toBe('other')
	expect(resolveOnboardingStep3SelectedAgent('other', 'cursor')).toBe('cursor')
})
