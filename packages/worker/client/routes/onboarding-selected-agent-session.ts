/**
 * Browser-session store for the Step 1 agent the visitor actually picked.
 *
 * Step 2 and Step 3 URLs do not carry the first agent, and the onboarding
 * payload only has grant counts — not a step-1 display name. Remember the
 * explicit choice so Step 2 can say "Copy a prompt to Cursor…" and Step 3
 * can grey the same-ecosystem family.
 */

import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'
import {
	isMcpClientKind,
	type McpClientKind,
} from '#universal/onboarding-mcp-clients.ts'

export const onboardingSelectedAgentSessionKey = 'kody.onboardingSelectedAgent'

let browserRemembered: McpClientKind | null = null

function isBrowserRuntime() {
	return typeof window !== 'undefined'
}

function asSelectedAgent(value: unknown): McpClientKind | null {
	if (typeof value !== 'string') return null
	if (!isMcpClientKind(value)) return null
	if (value === 'other') return null
	return value
}

export function rememberOnboardingSelectedAgent(agent: McpClientKind) {
	if (!isBrowserRuntime()) return
	// `other` is the overflow / generic-MCP path, not a first-agent identity.
	// Visiting /onboarding/step-1/not-listed must not wipe a named pick —
	// Step 3 greying and the same-ecosystem deep-link guard both read this.
	const stored = asSelectedAgent(agent)
	if (!stored) return
	browserRemembered = stored
	setSessionStorageItem(onboardingSelectedAgentSessionKey, stored)
}

export function readRememberedOnboardingSelectedAgent(): McpClientKind | null {
	if (!isBrowserRuntime()) return null
	if (browserRemembered && asSelectedAgent(browserRemembered)) {
		return browserRemembered
	}
	const stored = asSelectedAgent(
		getSessionStorageItem(onboardingSelectedAgentSessionKey),
	)
	if (!stored) return null
	browserRemembered = stored
	return stored
}

/** Test helper — drops in-memory and sessionStorage copies. */
export function clearOnboardingSelectedAgentSession() {
	browserRemembered = null
	try {
		sessionStorage.removeItem(onboardingSelectedAgentSessionKey)
	} catch {
		// Private mode / missing storage — in-memory is already cleared.
	}
}
