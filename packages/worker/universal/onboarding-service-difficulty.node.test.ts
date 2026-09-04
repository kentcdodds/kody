import { expect, test } from 'vitest'
import {
	onboardingFeaturedMcpServerIds,
	onboardingFeaturedMcpServers,
	onboardingNotListedPromptServices,
	onboardingNotListedServiceId,
} from './onboarding-mcp-chooser.ts'
import {
	classifyOnboardingAuthDifficulty,
	onboardingPatFirstServiceIds,
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

	expect(onboardingPatFirstServiceIds).toEqual([])

	for (const server of onboardingFeaturedMcpServers) {
		expect(server.url.length, server.id).toBeGreaterThan(0)
		expect(onboardingServiceEasiestAuthPath(server.id), server.id).toBe(
			'official-mcp',
		)
		expect(onboardingServiceDifficulty(server.id), server.id).toBe('easy')
	}

	expect(onboardingServiceDifficulty('github')).toBe('easy')
	expect(
		onboardingFeaturedMcpServers.find((server) => server.id === 'github')
			?.hasOauthPatAlternative,
	).toBe(true)
	expect(onboardingServiceDifficulty('notion')).toBe('easy')
	expect(onboardingServiceDifficulty('canva')).toBe('easy')

	const byoIds = onboardingNotListedPromptServices.map((service) => service.id)
	expect(byoIds).toEqual([
		'google',
		'slack',
		'discord',
		'spotify',
		'x',
		'asana',
		'dropbox',
		'linkedin',
		'zoom',
	])
	for (const id of byoIds) {
		expect(onboardingServiceEasiestAuthPath(id), id).toBe('oauth')
		expect(onboardingServiceDifficulty(id), id).toBe('hard')
	}

	expect(onboardingServiceDifficulty('google')).toBe('hard')
	expect(
		onboardingServiceEasiestAuthPath(onboardingNotListedServiceId),
	).toBeNull()
	expect(onboardingServiceDifficulty(onboardingNotListedServiceId)).toBeNull()

	const catalogIds = [
		...onboardingFeaturedMcpServerIds,
		...byoIds,
		onboardingNotListedServiceId,
	]
	expect(new Set(catalogIds).size).toBe(catalogIds.length)
	expect(
		catalogIds.filter((id) => onboardingServiceDifficulty(id) === 'medium'),
	).toEqual([])
})
