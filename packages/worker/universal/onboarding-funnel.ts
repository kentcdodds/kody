/**
 * Activation-funnel stage names and the only dimensions that may leave the
 * product path. No prompts, secrets, emails, or free-text errors.
 *
 * Unique-user counts group on `index1` (stable user id). Dimensions are
 * closed enums or stripped card ids.
 */

import { entitlementResources } from './plans.ts'
import { onboardingChecklistItems } from './onboarding-process.ts'
import { waitingFirstUseIds } from './waiting.ts'

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

export const onboardingFunnelPlans = ['standard', 'pro'] as const

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

const fixedWaitingCardIds = new Set([
	'verify-email',
	'secret-expired',
	'secret-expired-more',
	'email-change',
	'error-rate',
])

const firstUseCardIds = new Set(
	waitingFirstUseIds.map((id) => `first-use:${id}`),
)

const onboardingCardIds = new Set(
	onboardingChecklistItems.map((item) => `onboarding:${item.id}`),
)

const entitlementCardIds = new Set(
	entitlementResources.map((resource) => `entitlement:${resource}`),
)

const integrationAuthSlugPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
const publishLockIdPattern =
	/^publish-lock:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Map a Waiting item id to a funnel card id. Secret names never pass through.
 * Unknown ids are dropped rather than stored.
 */
export function sanitizeWaitingCardId(cardId: string): string | null {
	const trimmed = cardId.trim()
	if (!trimmed || trimmed.length > 80) return null
	if (trimmed.startsWith('secret-expired')) return 'secret-expired'
	if (trimmed === 'mcp-server' || trimmed.startsWith('mcp-server:')) {
		return 'mcp-server'
	}
	if (fixedWaitingCardIds.has(trimmed)) return trimmed
	if (firstUseCardIds.has(trimmed)) return trimmed
	if (onboardingCardIds.has(trimmed)) return trimmed
	if (entitlementCardIds.has(trimmed)) return trimmed
	if (trimmed.startsWith('integration-auth:')) {
		const slug = trimmed.slice('integration-auth:'.length)
		return integrationAuthSlugPattern.test(slug)
			? `integration-auth:${slug}`
			: 'integration-auth'
	}
	if (publishLockIdPattern.test(trimmed)) return trimmed
	if (trimmed === 'publish-lock' || trimmed.startsWith('publish-lock:')) {
		return 'publish-lock'
	}
	return null
}

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
		if (url.username || url.password || url.search || url.hash) {
			return url.hostname.slice(0, 120)
		}
		return url.hostname.slice(0, 120)
	} catch {
		const cleaned = trimmed.replace(/[^a-zA-Z0-9._:-]/g, '')
		return cleaned.slice(0, 80)
	}
}
