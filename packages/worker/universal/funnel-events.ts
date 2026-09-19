/**
 * Closed onboarding-funnel event names and property sanitizers.
 *
 * Browser and worker both import this. The write path lives in
 * `#worker/funnel/record-funnel-event.ts`. Properties stay low-cardinality
 * tokens. Raw client ids, prompts, emails, and secret values never qualify.
 */

import { classifyMcpClientName } from '#universal/connected-mcp-agents.ts'
import { isMcpClientKind } from '#universal/onboarding-mcp-clients.ts'
import { onboardingChecklistItems } from '#universal/onboarding-process.ts'
import { entitlementResources } from '#universal/plans.ts'
import { waitingFirstUseIds, waitingItemKinds } from '#universal/waiting.ts'

export const funnelEventNames = [
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

export type FunnelEventName = (typeof funnelEventNames)[number]

export const funnelFirstEventNames = [
	'first_search',
	'first_execute',
	'first_package',
	'first_secret',
	'first_integration',
	'first_job',
] as const satisfies ReadonlyArray<FunnelEventName>

export type FunnelFirstEventName = (typeof funnelFirstEventNames)[number]

export const funnelStageOrder = funnelEventNames

const funnelFirstEventNameSet = new Set<string>(funnelFirstEventNames)

export function isFunnelEventName(value: string): value is FunnelEventName {
	return (funnelEventNames as ReadonlyArray<string>).includes(value)
}

export function isFunnelFirstEventName(
	value: string,
): value is FunnelFirstEventName {
	return funnelFirstEventNameSet.has(value)
}

const onboardingCardIds = new Set(
	onboardingChecklistItems.map((item) => `onboarding:${item.id}`),
)
const firstUseCardIds = new Set(
	waitingFirstUseIds.map((id) => `first-use:${id}`),
)
const entitlementCardIds = new Set(
	entitlementResources.map((resource) => `entitlement:${resource}`),
)
const waitingKindIds = new Set<string>(waitingItemKinds)

/**
 * Collapse a host label or known client kind to a closed family. Random
 * OAuth `client_id` values are `unknown` so they do not become a high-cardinality
 * Analytics Engine blob.
 */
export function sanitizeClientFamily(value: string | null | undefined): string {
	const trimmed = value?.trim() ?? ''
	if (!trimmed) return 'unknown'
	if (isMcpClientKind(trimmed)) return trimmed
	return classifyMcpClientName(trimmed).kind ?? 'unknown'
}

const funnelPlans = ['standard', 'pro'] as const

export function sanitizeFunnelPlan(value: string | null | undefined): string {
	if (value === 'standard' || value === 'pro') return value
	return 'unknown'
}

export type FunnelPlan = (typeof funnelPlans)[number] | 'unknown'

/**
 * Error classes are short tokens (`invalid_pkce`, `access_denied`). Sentences
 * and free-text OAuth descriptions collapse to `other`.
 */
export function sanitizeFunnelErrorClass(
	value: string | null | undefined,
): string {
	const trimmed = value?.trim().toLowerCase() ?? ''
	if (!/^[a-z0-9_]{1,40}$/.test(trimmed)) return 'other'
	return trimmed
}

/** Waiting click ids are closed cards, not server UUIDs or emails. */
export function sanitizeWaitingCardId(
	value: string | null | undefined,
): string {
	const trimmed = value?.trim() ?? ''
	if (!trimmed) return 'other'
	if (onboardingCardIds.has(trimmed)) return trimmed
	if (firstUseCardIds.has(trimmed)) return trimmed
	if (entitlementCardIds.has(trimmed)) return trimmed
	if (waitingKindIds.has(trimmed)) return trimmed
	return 'other'
}

export type AdminFunnelStage = {
	event: FunnelEventName
	days7: number
	days28: number
}

export type AdminFunnelSummary = {
	source: 'analytics_engine' | 'd1' | 'unavailable'
	stages: Array<AdminFunnelStage>
}

export const funnelEventLabels: Record<FunnelEventName, string> = {
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
