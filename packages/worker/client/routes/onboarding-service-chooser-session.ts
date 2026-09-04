/**
 * Browser-session store for the onboarding Step 2 MCP-picker order.
 *
 * The HTML handler picks once per document request. Hydrate and later SPA
 * loads of Step 2 must reuse that array — shuffling again on
 * `onboardingRouteLoader` reorders the chips and confuses people. Module
 * state is client-only so a Worker isolate never shares one visitor's pick
 * with the next.
 */

import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'
import {
	isValidOnboardingServiceChooserPick,
	pickOnboardingServiceChooser,
	type OnboardingServiceChooserPick,
} from '#universal/onboarding-mcp-chooser.ts'
import { type OnboardingRandomInt } from '#universal/onboarding-mcp-clients.ts'

export const onboardingServiceChooserSessionKey =
	'kody.onboardingServiceChooser'

let browserRemembered: OnboardingServiceChooserPick | null = null

function isBrowserRuntime() {
	return typeof window !== 'undefined'
}

function asChooserPick(value: unknown): OnboardingServiceChooserPick | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const pick = {
		featured: record.featured,
		overflow: record.overflow,
	}
	if (!Array.isArray(pick.featured) || !Array.isArray(pick.overflow)) {
		return null
	}
	const candidate = pick as OnboardingServiceChooserPick
	return isValidOnboardingServiceChooserPick(candidate) ? candidate : null
}

export function rememberOnboardingServiceChooser(
	pick: OnboardingServiceChooserPick,
) {
	if (!isValidOnboardingServiceChooserPick(pick)) return
	if (!isBrowserRuntime()) return
	browserRemembered = pick
	setSessionStorageItem(
		onboardingServiceChooserSessionKey,
		JSON.stringify(pick),
	)
}

export function readRememberedOnboardingServiceChooser(): OnboardingServiceChooserPick | null {
	if (!isBrowserRuntime()) return null
	if (
		browserRemembered &&
		isValidOnboardingServiceChooserPick(browserRemembered)
	) {
		return browserRemembered
	}
	let parsed: unknown = null
	try {
		parsed = JSON.parse(
			getSessionStorageItem(onboardingServiceChooserSessionKey) ?? 'null',
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
export function resolveOnboardingServiceChooser(
	randomInt?: OnboardingRandomInt,
): OnboardingServiceChooserPick {
	const remembered = readRememberedOnboardingServiceChooser()
	if (remembered) return remembered
	const pick = pickOnboardingServiceChooser(randomInt)
	rememberOnboardingServiceChooser(pick)
	return pick
}

/** Test helper — drops in-memory and sessionStorage copies. */
export function clearOnboardingServiceChooserSession() {
	browserRemembered = null
	try {
		sessionStorage.removeItem(onboardingServiceChooserSessionKey)
	} catch {
		// Private mode / missing storage — in-memory is already cleared.
	}
}
