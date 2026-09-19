/**
 * Tiny Analytics Engine writer for funnel stamps. No MCP client classifier
 * and no Waiting imports, so runtime execute can stamp without growing the
 * startup bundle.
 */

import {
	onboardingFunnelStages,
	sanitizeFunnelClientId,
	sanitizeMcpConnectErrorClass,
	sanitizeOnboardingFunnelPlan,
	type OnboardingFunnelStage,
} from '#universal/onboarding-funnel-point.ts'
import { isStableUserId } from '#worker/user-id.ts'

export type OnboardingFunnelEnv = {
	ONBOARDING_FUNNEL_EVENTS?: AnalyticsEngineDataset
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	/**
	 * Shared with write envs (`UsageEnv`, secret/integration writers) so
	 * those narrower picks stay assignable. The funnel does not query it.
	 */
	APP_DB?: D1Database
}

type OnboardingFunnelPoint = {
	stage: OnboardingFunnelStage
	userId: string
	dimension?: string
	errorClass?: string
	clientId?: string
}

const stageSet = new Set<string>(onboardingFunnelStages)

function dimensionFor(input: OnboardingFunnelPoint) {
	if (
		input.stage === 'checkout_started' ||
		input.stage === 'checkout_completed'
	) {
		return sanitizeOnboardingFunnelPlan(input.dimension) ?? ''
	}
	if (input.stage === 'waiting_card_clicked') {
		return input.dimension?.trim().slice(0, 80) ?? ''
	}
	if (input.stage.startsWith('mcp_connect_')) {
		return input.dimension?.trim().slice(0, 40) ?? ''
	}
	return ''
}

/**
 * Record one funnel point. Never throws. Skips when the user id is not a
 * stable id, so an email cannot land in Analytics Engine by mistake.
 */
export function recordOnboardingFunnelEvent(
	env: OnboardingFunnelEnv,
	input: OnboardingFunnelPoint,
): void {
	try {
		if (!env.ONBOARDING_FUNNEL_EVENTS) return
		if (!isStableUserId(input.userId)) return
		if (!stageSet.has(input.stage)) return
		const errorClass =
			input.stage === 'mcp_connect_failed'
				? sanitizeMcpConnectErrorClass(input.errorClass)
				: ''
		const clientId = input.stage.startsWith('mcp_connect_')
			? sanitizeFunnelClientId(input.clientId)
			: ''
		env.ONBOARDING_FUNNEL_EVENTS.writeDataPoint({
			indexes: [input.userId],
			blobs: [input.stage, dimensionFor(input), errorClass, clientId],
			doubles: [1],
		})
	} catch (error) {
		console.warn('onboarding-funnel-event-failed', error)
	}
}

export function recordCheckoutFunnelEvent(
	env: OnboardingFunnelEnv,
	input: {
		stage: 'checkout_started' | 'checkout_completed'
		userId: string | null | undefined
		plan: string | null | undefined
	},
): void {
	const userId = input.userId?.trim() ?? ''
	const plan = sanitizeOnboardingFunnelPlan(input.plan)
	if (!userId || !plan) return
	recordOnboardingFunnelEvent(env, {
		stage: input.stage,
		userId,
		dimension: plan,
	})
}
