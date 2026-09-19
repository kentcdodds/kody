/**
 * Funnel stage names and the dimensions written on an Analytics Engine point.
 * Kept free of Waiting and onboarding UI imports so runtime execute stamping
 * does not pull those modules into the startup bundle.
 */

export const onboardingFunnelStages = [
	'signup_started',
	'signup_completed',
	'email_verified',
	'mcp_connect_started',
	'mcp_connect_succeeded',
	'mcp_connect_failed',
	'first_search',
	'first_execute',
	'first_package',
	'first_secret',
	'first_integration',
	'first_job',
	'waiting_card_clicked',
	'checkout_started',
	'checkout_completed',
] as const

export type OnboardingFunnelStage = (typeof onboardingFunnelStages)[number]

export const onboardingFunnelStageLabels: Record<
	OnboardingFunnelStage,
	string
> = {
	signup_started: 'Signup started',
	signup_completed: 'Signup completed',
	email_verified: 'Email verified',
	mcp_connect_started: 'MCP connect started',
	mcp_connect_succeeded: 'MCP connect succeeded',
	mcp_connect_failed: 'MCP connect failed',
	first_search: 'First search',
	first_execute: 'First execute',
	first_package: 'First package',
	first_secret: 'First secret',
	first_integration: 'First integration',
	first_job: 'First job',
	waiting_card_clicked: 'Waiting card clicked',
	checkout_started: 'Checkout started',
	checkout_completed: 'Checkout completed',
}

const onboardingFunnelPlans = ['standard', 'pro'] as const

export type OnboardingFunnelPlan = (typeof onboardingFunnelPlans)[number]

const onboardingFunnelPlanSet = new Set<string>(onboardingFunnelPlans)

const mcpConnectErrorClasses = [
	'invalid_request',
	'invalid_pkce_method',
	'missing_credentials',
	'invalid_credentials',
	'username_missing',
	'two_factor_required',
	'session_user_not_found',
	'email_verification_required',
	'interaction_required',
	'consent_required',
	'invalid_scope',
	'access_denied',
	'server_error',
	'other',
] as const

const mcpConnectErrorClassSet = new Set<string>(mcpConnectErrorClasses)

export function sanitizeOnboardingFunnelPlan(
	plan: string | null | undefined,
): OnboardingFunnelPlan | null {
	const trimmed = plan?.trim() ?? ''
	return onboardingFunnelPlanSet.has(trimmed)
		? (trimmed as OnboardingFunnelPlan)
		: null
}

export function sanitizeMcpConnectErrorClass(
	errorClass: string | null | undefined,
): string {
	const trimmed = errorClass?.trim().toLowerCase() ?? ''
	return mcpConnectErrorClassSet.has(trimmed) ? trimmed : 'other'
}

/**
 * OAuth client ids are often metadata URLs. Keep a hostname or a short token,
 * never a query string (refresh material sometimes rides there).
 */
export function sanitizeFunnelClientId(
	clientId: string | null | undefined,
): string {
	const trimmed = clientId?.trim() ?? ''
	if (!trimmed || trimmed.includes('@') || /\s/.test(trimmed)) return ''
	try {
		const url = new URL(trimmed)
		return url.hostname.slice(0, 120)
	} catch {
		const cleaned = trimmed.replace(/[^a-zA-Z0-9._:-]/g, '')
		return cleaned.slice(0, 80)
	}
}
