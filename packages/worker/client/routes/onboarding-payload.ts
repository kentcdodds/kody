import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	type OnboardingBuiltInProvider,
	type OnboardingChecklistLoaderData,
	type OnboardingWelcomeEmail,
} from '#universal/loader-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

/**
 * Onboarding status payload + fetcher, split from `onboarding.tsx` so the
 * homepage (and other eager routes) can read onboarding state without pulling
 * the whole onboarding route UI into the critical-path bundle chunk.
 */
export type OnboardingPayload = {
	ok: true
	loggedIn: boolean
	mcpServerUrl: string
	setupPrompt: string
	discoveryPrompt: string
	firstWinPrompt: string
	hasSentWelcomeEmail: boolean
	welcomeEmail: OnboardingWelcomeEmail | null
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
	featuredListings: Array<OnboardingFeaturedListing>
	builtInProviders: Array<OnboardingBuiltInProvider>
	checklist: OnboardingChecklistLoaderData | null
}

export const onboardingApiPath = '/onboarding.json'

export async function fetchOnboardingPayload(signal?: AbortSignal) {
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) return null
	return payload
}
