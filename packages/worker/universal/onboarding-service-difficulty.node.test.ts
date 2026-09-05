import { expect, test } from 'vitest'
import {
	onboardingFeaturedMcpServers,
	onboardingNotListedServiceId,
} from './onboarding-mcp-chooser.ts'
import {
	classifyOnboardingAuthDifficulty,
	onboardingServiceDifficulty,
	onboardingServiceDifficultyFilledCount,
	onboardingServiceEasiestAuthPath,
} from './onboarding-service-difficulty.ts'

test('difficulty is the easiest available path, not the most powerful', () => {
	expect(classifyOnboardingAuthDifficulty('official-mcp')).toBe('easy')
	expect(classifyOnboardingAuthDifficulty('pat')).toBe('medium')
	expect(classifyOnboardingAuthDifficulty('oauth')).toBe('hard')
	expect(classifyOnboardingAuthDifficulty(null)).toBeNull()
	expect(onboardingServiceDifficultyFilledCount('easy')).toBe(1)
	expect(onboardingServiceDifficultyFilledCount('medium')).toBe(2)
	expect(onboardingServiceDifficultyFilledCount('hard')).toBe(3)

	expect(onboardingServiceDifficulty('github')).toBe('easy')
	expect(
		onboardingFeaturedMcpServers.find((server) => server.id === 'github')
			?.hasOauthPatAlternative,
	).toBe(true)
	expect(onboardingServiceDifficulty('google')).toBe('hard')
	expect(onboardingServiceEasiestAuthPath('google')).toBe('oauth')
	expect(
		onboardingServiceEasiestAuthPath(onboardingNotListedServiceId),
	).toBeNull()
	expect(onboardingServiceDifficulty(onboardingNotListedServiceId)).toBeNull()
})
