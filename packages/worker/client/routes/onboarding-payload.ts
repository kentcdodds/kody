import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/loader-data.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
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
	hasAccessWin: boolean
	hasSecondMcpClient: boolean
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
	featuredListings: Array<OnboardingFeaturedListing>
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
	/**
	 * Most recently updated saved-package user-facing name (`@scope/kody-id`)
	 * after persist. Null when logged out, unverified, or the listing fails
	 * open.
	 */
	persistedPackageName: string | null
	/**
	 * Most recently updated active memory subject from a Step 2 access win.
	 * Null when logged out, unverified, none exist, or the listing fails open.
	 */
	accessWinMemorySubject: string | null
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
let inFlightController: AbortController | null = null
let cache: OnboardingPayloadCache | null = null
let loadGeneration = 0

function monotonicNow() {
	return performance.now()
}

/**
 * Drop the settled payload and any in-flight `/onboarding.json` so a form
 * POST cannot be followed by pre-mutation progress. Late completions of
 * the aborted request must not rewrite `cache`.
 */
export function clearOnboardingPayloadCache() {
	cache = null
	loadGeneration += 1
	inFlightController?.abort()
	inFlightController = null
	inFlight = null
}

async function loadOnboardingPayload(generation: number, signal: AbortSignal) {
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) return null
	if (generation === loadGeneration) {
		cache = { payload, at: monotonicNow() }
	}
	return payload
}

function adoptSharedPayload(
	shared: Promise<OnboardingPayload | null>,
	signal?: AbortSignal,
) {
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

export async function fetchOnboardingPayload(
	signal?: AbortSignal,
	options?: { fresh?: boolean },
) {
	const fresh = options?.fresh === true
	if (
		!fresh &&
		cache &&
		monotonicNow() - cache.at <= onboardingPayloadCacheTtlMs
	) {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
		return cache.payload
	}
	if (!inFlight) {
		const generation = loadGeneration
		const controller = new AbortController()
		inFlightController = controller
		inFlight = loadOnboardingPayload(generation, controller.signal).finally(
			() => {
				if (inFlightController === controller) {
					inFlightController = null
					inFlight = null
				}
			},
		)
	}
	return adoptSharedPayload(inFlight, signal)
}
