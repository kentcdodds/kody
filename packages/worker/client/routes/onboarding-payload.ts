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

/**
 * Chip navigations and render prefetch all hit this payload. Keep one
 * in-flight request and reuse a short-lived result so a picker cannot
 * stampede `/onboarding.json` on a loaded Vite origin.
 */
export const onboardingPayloadCacheTtlMs = 30_000

type OnboardingPayloadCache = {
	payload: OnboardingPayload
	at: number
}

let inFlight: Promise<OnboardingPayload | null> | null = null
let cache: OnboardingPayloadCache | null = null

function monotonicNow() {
	return performance.now()
}

export function clearOnboardingPayloadCache() {
	cache = null
}

async function loadOnboardingPayload() {
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
	})
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) return null
	cache = { payload, at: monotonicNow() }
	return payload
}

export async function fetchOnboardingPayload(signal?: AbortSignal) {
	if (cache && monotonicNow() - cache.at <= onboardingPayloadCacheTtlMs) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
		return cache.payload
	}
	if (!inFlight) {
		inFlight = loadOnboardingPayload().finally(() => {
			inFlight = null
		})
	}
	const shared = inFlight
	if (!signal) return shared
	if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
	return new Promise<OnboardingPayload | null>((resolve, reject) => {
		const onAbort = () => {
			reject(new DOMException('Aborted', 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
		void shared.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}
