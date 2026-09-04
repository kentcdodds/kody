/**
 * Step 2 service-detail difficulty: the *easiest* available path, not the
 * most powerful. Official hosted MCP remotes win over PAT or a BYO OAuth app.
 *
 * Ranking:
 * 1. easy — catalog row with a hosted MCP URL
 * 2. medium — PAT / API key as the easiest remaining path (no official MCP)
 * 3. hard — register your own OAuth app (Google is the example)
 *
 * `hasOauthPatAlternative` is a more-powerful extra lane. It must not bump
 * an official MCP chip off easy. Not-listed has no inferred level.
 */

import {
	onboardingFeaturedMcpServerById,
	onboardingNotListedPromptServices,
	onboardingNotListedServiceId,
	type OnboardingNotListedPromptServiceId,
	type OnboardingServiceChoice,
} from '#universal/onboarding-mcp-chooser.ts'

export const onboardingServiceDifficultyLevels = [
	'easy',
	'medium',
	'hard',
] as const

export type OnboardingServiceDifficulty =
	(typeof onboardingServiceDifficultyLevels)[number]

export type OnboardingAuthPathKind = 'official-mcp' | 'pat' | 'oauth'

/**
 * BYO chips whose easiest documented path is a PAT / API key and that do
 * *not* have an official MCP remote. Empty today: GitHub's PAT lane is real,
 * but GitHub is already in the MCP catalog, so easiest = easy.
 */
export const onboardingPatFirstServiceIds =
	[] as const satisfies ReadonlyArray<OnboardingNotListedPromptServiceId>

export function classifyOnboardingAuthDifficulty(
	easiestPath: OnboardingAuthPathKind | null,
): OnboardingServiceDifficulty | null {
	if (easiestPath == null) return null
	switch (easiestPath) {
		case 'official-mcp':
			return 'easy'
		case 'pat':
			return 'medium'
		case 'oauth':
			return 'hard'
		default: {
			const unexpected: never = easiestPath
			throw new Error(`Unhandled onboarding auth path: ${unexpected}`)
		}
	}
}

export function onboardingServiceEasiestAuthPath(
	service: OnboardingServiceChoice,
): OnboardingAuthPathKind | null {
	if (service === onboardingNotListedServiceId) return null
	if (onboardingFeaturedMcpServerById(service)) return 'official-mcp'
	if (
		(onboardingPatFirstServiceIds as ReadonlyArray<string>).includes(service)
	) {
		return 'pat'
	}
	if (
		onboardingNotListedPromptServices.some(
			(candidate) => candidate.id === service,
		)
	) {
		return 'oauth'
	}
	return null
}

export function onboardingServiceDifficulty(
	service: OnboardingServiceChoice,
): OnboardingServiceDifficulty | null {
	return classifyOnboardingAuthDifficulty(
		onboardingServiceEasiestAuthPath(service),
	)
}

export function onboardingServiceDifficultyFilledCount(
	level: OnboardingServiceDifficulty,
): 1 | 2 | 3 {
	switch (level) {
		case 'easy':
			return 1
		case 'medium':
			return 2
		case 'hard':
			return 3
		default: {
			const unexpected: never = level
			throw new Error(`Unhandled onboarding difficulty: ${unexpected}`)
		}
	}
}
