import { expect, test } from 'vitest'
import {
	isOnboardingSameEcosystemAgent,
	onboardingAgentEcosystem,
	onboardingGreyedSecondAgents,
	onboardingSameEcosystemDisabledReason,
	onboardingSameEcosystemAgents,
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
