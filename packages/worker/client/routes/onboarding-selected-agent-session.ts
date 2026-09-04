/**
 * Browser-session store for the Step 1 agent the visitor actually picked.
 *
 * Step 2 URLs do not carry the agent, and the onboarding payload only has
 * `hasMcpClient` — not a step-1 display name. Remember the explicit choice
 * so `/onboarding/step-2/:service` can say "Copy this prompt to Cursor…"
 * instead of inventing a host from raw MCP client ids (`claude-ai`).
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
	const stored = asSelectedAgent(agent)
	if (!stored) return
	if (!isBrowserRuntime()) return
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
