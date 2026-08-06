/**
 * Onboarding checklist item ids, in display order. Kept in a dependency-free
 * module because both the client-safe loader payload types and the MCP-layer
 * derivation service need them.
 */
export type OnboardingChecklistItemId =
	| 'verify-email'
	| 'connect-agent'
	| 'first-hello'
	| 'save-memory'
	| 'connect-integration'
	| 'install-starter'

export type OnboardingChecklistItem = {
	id: OnboardingChecklistItemId
	done: boolean
}
