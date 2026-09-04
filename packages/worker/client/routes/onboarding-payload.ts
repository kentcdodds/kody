import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/loader-data.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type OnboardingSessionMilestoneState } from '#universal/onboarding-process.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

/**
 * Onboarding status payload + fetcher, split from `onboarding.tsx` so the
 * homepage (and other eager routes) can read onboarding state without pulling
 * the whole onboarding route UI into the critical-path bundle chunk.
 */
export type OnboardingPayload = {
	ok: true
	loggedIn: boolean
	username: string | null
	mcpServerUrl: string
	mcpHighlights?: Record<string, HighlightedCode>
	setupPrompt: string
	discoveryPrompt: string
	persistPrompt: string
	milestones: OnboardingSessionMilestoneState
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
	featuredListings: Array<OnboardingFeaturedListing>
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
	/**
	 * Most recently updated saved-package kody id after persist. Null when
	 * logged out, unverified, or the listing fails open.
	 */
	persistedPackageKodyId: string | null
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
