/**
 * Browser-session store for the onboarding agent-picker order.
 *
 * The HTML handler picks once per document request. Hydrate and later SPA
 * loads of the selection step must reuse that array — shuffling again on
 * `onboardingRouteLoader` (select → next → change selection) reorders the
 * cards and confuses people. Module state is client-only so a Worker isolate
 * never shares one visitor's pick with the next.
 */

import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'
import {
	isValidOnboardingAgentChooserPick,
	pickOnboardingAgentChooser,
	type OnboardingAgentChooserPick,
	type OnboardingRandomInt,
} from '#universal/onboarding-mcp-clients.ts'

export const onboardingAgentChooserSessionKey = 'kody.onboardingAgentChooser'

let browserRemembered: OnboardingAgentChooserPick | null = null

function isBrowserRuntime() {
	return typeof window !== 'undefined'
}

function asChooserPick(value: unknown): OnboardingAgentChooserPick | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const pick = {
		desktopFeatured: record.desktopFeatured,
		mobileFeatured: record.mobileFeatured,
		desktopMore: record.desktopMore,
		mobileMore: record.mobileMore,
	}
	if (
		!Array.isArray(pick.desktopFeatured) ||
		!Array.isArray(pick.mobileFeatured) ||
		!Array.isArray(pick.desktopMore) ||
		!Array.isArray(pick.mobileMore)
	) {
		return null
	}
	const candidate = pick as OnboardingAgentChooserPick
	return isValidOnboardingAgentChooserPick(candidate) ? candidate : null
}

export function rememberOnboardingAgentChooser(
	pick: OnboardingAgentChooserPick,
) {
	if (!isValidOnboardingAgentChooserPick(pick)) return
	if (!isBrowserRuntime()) return
	browserRemembered = pick
	setSessionStorageItem(onboardingAgentChooserSessionKey, JSON.stringify(pick))
}

export function readRememberedOnboardingAgentChooser(): OnboardingAgentChooserPick | null {
	if (!isBrowserRuntime()) return null
	if (
		browserRemembered &&
		isValidOnboardingAgentChooserPick(browserRemembered)
	) {
		return browserRemembered
	}
	let parsed: unknown = null
	try {
		parsed = JSON.parse(
			getSessionStorageItem(onboardingAgentChooserSessionKey) ?? 'null',
		)
	} catch {
		return null
	}
	const stored = asChooserPick(parsed)
	if (!stored) return null
	browserRemembered = stored
	return stored
}

/**
 * Reuse the SSR / first-pick order for the rest of this browser session.
 * A full document request starts a new JS context and SSR may pick again.
 */
export function resolveOnboardingAgentChooser(
	randomInt?: OnboardingRandomInt,
): OnboardingAgentChooserPick {
	const remembered = readRememberedOnboardingAgentChooser()
	if (remembered) return remembered
	const pick = pickOnboardingAgentChooser(randomInt)
	rememberOnboardingAgentChooser(pick)
	return pick
}

/** Test helper — drops in-memory and sessionStorage copies. */
export function clearOnboardingAgentChooserSession() {
	browserRemembered = null
	try {
		sessionStorage.removeItem(onboardingAgentChooserSessionKey)
	} catch {
		// Private mode / missing storage — in-memory is already cleared.
	}
}
