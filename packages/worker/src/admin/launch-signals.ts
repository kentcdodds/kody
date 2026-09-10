/**
 * D1-only launch signals for `/admin/insights`. Every query is a COUNT or
 * GROUP BY — the page never pages users or fans out per-account reads.
 */

import { classifyMcpClientName } from '#universal/connected-mcp-agents.ts'
import {
	type AdminInsightsLaunchFunnelStep,
	type AdminInsightsLaunchSignals,
	type AdminInsightsMcpClientSlice,
	type AdminInsightsPaidSlice,
	type AdminInsightsPlanSlice,
} from '#universal/loader-data.ts'
import {
	platformPublicOpenedAt,
	platformPublicOpenedDay,
} from '#universal/platform-open.ts'
import {
	monthlyRecurringRevenueUsdCents,
	resolveStripePriceCatalog,
} from '#worker/billing/stripe-price-catalog.ts'
import { type BillingEnv } from '#worker/billing/billing-config.ts'

const dayMs = 24 * 60 * 60 * 1000
const launchFunnelSteps = [
	'signed_up',
	'email_verified',
	'first_mcp',
	'first_search',
	'first_execute',
	'first_saved_package',
] as const satisfies ReadonlyArray<AdminInsightsLaunchFunnelStep['step']>

type CountRow = { n: number }
type NamedCountRow = { name: string; n: number }
type PaidPriceRow = {
	stripe_plan: string
	stripe_price_id: string
	n: number
}
type LaunchTotalsRow = {
	signed_up: number
	verified: number
	first_mcp: number
	first_search: number
	first_execute: number
	first_saved_package: number
	signed_up_since_open: number
	verified_since_open: number
	first_mcp_since_open: number
	first_search_since_open: number
	first_execute_since_open: number
	first_saved_package_since_open: number
	active_24h: number
	active_48h: number
	active_7d: number
	manual_free: number
	manual_standard: number
	manual_pro: number
	manual_max: number
	stripe_none: number
	stripe_standard: number
	stripe_pro: number
	ladder_public: number
	ladder_legacy: number
	ladder_legacy_paid: number
	overlay_standard: number
}

function toCount(value: number | null | undefined) {
	return Number(value ?? 0)
}

function funnelSteps(counts: {
	signed_up: number
	email_verified: number
	first_mcp: number
	first_search: number
	first_execute: number
	first_saved_package: number
}): Array<AdminInsightsLaunchFunnelStep> {
	return launchFunnelSteps.map((step) => ({
		step,
		users: counts[step],
	}))
}

function planSlices(
	counts: Record<string, number>,
): Array<AdminInsightsPlanSlice> {
	return Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([plan, count]) => ({ plan, count }))
		.sort(
			(left, right) =>
				right.count - left.count || left.plan.localeCompare(right.plan),
		)
}

export async function loadAdminLaunchSignals(input: {
	db: D1Database
	env: BillingEnv
	now: Date
}): Promise<AdminInsightsLaunchSignals> {
	const nowIso = input.now.toISOString()
	const active24h = new Date(input.now.getTime() - dayMs).toISOString()
	const active48h = new Date(input.now.getTime() - 2 * dayMs).toISOString()
	const active7d = new Date(input.now.getTime() - 7 * dayMs).toISOString()
	const catalog = resolveStripePriceCatalog(input.env)

	const [totals, paidRows, effectiveRows, clientRows, openFeedback] =
		await Promise.all([
			input.db
				.prepare(
					`SELECT
						COUNT(*) AS signed_up,
						SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
						SUM(CASE WHEN first_mcp_connected_at IS NOT NULL THEN 1 ELSE 0 END) AS first_mcp,
						SUM(CASE WHEN first_search_at IS NOT NULL THEN 1 ELSE 0 END) AS first_search,
						SUM(CASE WHEN first_execute_at IS NOT NULL THEN 1 ELSE 0 END) AS first_execute,
						SUM(CASE WHEN first_saved_package_at IS NOT NULL THEN 1 ELSE 0 END) AS first_saved_package,
						SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS signed_up_since_open,
						SUM(CASE WHEN created_at >= ? AND email_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified_since_open,
						SUM(CASE WHEN created_at >= ? AND first_mcp_connected_at IS NOT NULL THEN 1 ELSE 0 END) AS first_mcp_since_open,
						SUM(CASE WHEN created_at >= ? AND first_search_at IS NOT NULL THEN 1 ELSE 0 END) AS first_search_since_open,
						SUM(CASE WHEN created_at >= ? AND first_execute_at IS NOT NULL THEN 1 ELSE 0 END) AS first_execute_since_open,
						SUM(CASE WHEN created_at >= ? AND first_saved_package_at IS NOT NULL THEN 1 ELSE 0 END) AS first_saved_package_since_open,
						SUM(CASE WHEN last_active_at >= ? THEN 1 ELSE 0 END) AS active_24h,
						SUM(CASE WHEN last_active_at >= ? THEN 1 ELSE 0 END) AS active_48h,
						SUM(CASE WHEN last_active_at >= ? THEN 1 ELSE 0 END) AS active_7d,
						SUM(CASE WHEN plan = 'free' OR plan IS NULL THEN 1 ELSE 0 END) AS manual_free,
						SUM(CASE WHEN plan = 'standard' THEN 1 ELSE 0 END) AS manual_standard,
						SUM(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END) AS manual_pro,
						SUM(CASE WHEN plan = 'max' THEN 1 ELSE 0 END) AS manual_max,
						SUM(CASE WHEN stripe_plan IS NULL OR stripe_plan = '' THEN 1 ELSE 0 END) AS stripe_none,
						SUM(CASE WHEN stripe_plan = 'standard' THEN 1 ELSE 0 END) AS stripe_standard,
						SUM(CASE WHEN stripe_plan = 'pro' THEN 1 ELSE 0 END) AS stripe_pro,
						SUM(CASE WHEN COALESCE(entitlement_ladder, 'public') = 'public' THEN 1 ELSE 0 END) AS ladder_public,
						SUM(CASE WHEN COALESCE(entitlement_ladder, 'public') = 'legacy' THEN 1 ELSE 0 END) AS ladder_legacy,
						SUM(CASE WHEN COALESCE(entitlement_ladder, 'public') = 'legacy' AND stripe_plan IN ('standard', 'pro') THEN 1 ELSE 0 END) AS ladder_legacy_paid,
						SUM(CASE
							WHEN (plan IS NULL OR plan = 'free')
								AND (stripe_plan IS NULL OR stripe_plan NOT IN ('standard', 'pro'))
								AND (
									(second_agent_standard_gift_expires_at IS NOT NULL AND second_agent_standard_gift_expires_at > ?)
									OR (referral_standard_credit_expires_at IS NOT NULL AND referral_standard_credit_expires_at > ?)
								)
							THEN 1 ELSE 0 END) AS overlay_standard
					 FROM users
					 WHERE deleting_at IS NULL`,
				)
				.bind(
					platformPublicOpenedDay,
					platformPublicOpenedDay,
					platformPublicOpenedDay,
					platformPublicOpenedDay,
					platformPublicOpenedDay,
					platformPublicOpenedDay,
					active24h,
					active48h,
					active7d,
					nowIso,
					nowIso,
				)
				.first<LaunchTotalsRow>(),
			input.db
				.prepare(
					`SELECT COALESCE(stripe_plan, '') AS stripe_plan,
						COALESCE(stripe_price_id, '') AS stripe_price_id,
						COUNT(*) AS n
					 FROM users
					 WHERE deleting_at IS NULL
						AND stripe_plan IN ('standard', 'pro')
					 GROUP BY 1, 2`,
				)
				.all<PaidPriceRow>(),
			input.db
				.prepare(
					`SELECT
						CASE
							WHEN plan = 'max' THEN 'max'
							WHEN plan = 'pro' OR stripe_plan = 'pro' THEN 'pro'
							WHEN plan = 'standard' OR stripe_plan = 'standard' THEN 'standard'
							WHEN (
								(second_agent_standard_gift_expires_at IS NOT NULL AND second_agent_standard_gift_expires_at > ?)
								OR (referral_standard_credit_expires_at IS NOT NULL AND referral_standard_credit_expires_at > ?)
							) THEN 'standard'
							ELSE COALESCE(plan, 'free')
						END AS name,
						COUNT(*) AS n
					 FROM users
					 WHERE deleting_at IS NULL
					 GROUP BY 1`,
				)
				.bind(nowIso, nowIso)
				.all<NamedCountRow>(),
			input.db
				.prepare(
					`SELECT COALESCE(mcp_client_name, '') AS name, COUNT(*) AS n
					 FROM users
					 WHERE deleting_at IS NULL
						AND first_mcp_connected_at IS NOT NULL
					 GROUP BY 1`,
				)
				.all<NamedCountRow>(),
			input.db
				.prepare(
					`SELECT COUNT(*) AS n
					 FROM platform_feedback
					 WHERE status = 'open'`,
				)
				.first<CountRow>(),
		])

	const paid = foldPaidSlices(paidRows.results ?? [], catalog)
	const ladderLegacy = toCount(totals?.ladder_legacy)
	const ladderPublic = toCount(totals?.ladder_public)

	return {
		openedAt: platformPublicOpenedAt,
		openedDay: platformPublicOpenedDay,
		mrrUsdCents: paid.mrrUsdCents,
		paidSubscribers: paid.paidSubscribers,
		unpricedPaidSubscribers: paid.unpricedPaidSubscribers,
		paidSlices: paid.slices,
		manualPlans: planSlices({
			free: toCount(totals?.manual_free),
			standard: toCount(totals?.manual_standard),
			pro: toCount(totals?.manual_pro),
			max: toCount(totals?.manual_max),
		}),
		stripePlans: planSlices({
			none: toCount(totals?.stripe_none),
			standard: toCount(totals?.stripe_standard),
			pro: toCount(totals?.stripe_pro),
		}),
		effectivePlans: (effectiveRows.results ?? [])
			.map((row): AdminInsightsPlanSlice => ({
				plan: row.name || 'free',
				count: toCount(row.n),
			}))
			.filter((slice) => slice.count > 0)
			.sort(
				(left, right) =>
					right.count - left.count || left.plan.localeCompare(right.plan),
			),
		overlayStandard: toCount(totals?.overlay_standard),
		entitlementLadders: {
			public: ladderPublic,
			legacy: ladderLegacy,
		},
		paidEntitlementLadders: {
			legacy: toCount(totals?.ladder_legacy_paid),
			public: Math.max(
				0,
				toCount(totals?.stripe_standard) +
					toCount(totals?.stripe_pro) -
					toCount(totals?.ladder_legacy_paid),
			),
		},
		activeUsers: {
			hours24: toCount(totals?.active_24h),
			hours48: toCount(totals?.active_48h),
			days7: toCount(totals?.active_7d),
		},
		activation: {
			overall: funnelSteps({
				signed_up: toCount(totals?.signed_up),
				email_verified: toCount(totals?.verified),
				first_mcp: toCount(totals?.first_mcp),
				first_search: toCount(totals?.first_search),
				first_execute: toCount(totals?.first_execute),
				first_saved_package: toCount(totals?.first_saved_package),
			}),
			sinceOpen: funnelSteps({
				signed_up: toCount(totals?.signed_up_since_open),
				email_verified: toCount(totals?.verified_since_open),
				first_mcp: toCount(totals?.first_mcp_since_open),
				first_search: toCount(totals?.first_search_since_open),
				first_execute: toCount(totals?.first_execute_since_open),
				first_saved_package: toCount(totals?.first_saved_package_since_open),
			}),
		},
		mcpClients: foldMcpClients(clientRows.results ?? []),
		openPlatformFeedback: toCount(openFeedback?.n),
	}
}

function foldPaidSlices(
	rows: ReadonlyArray<PaidPriceRow>,
	catalog: ReturnType<typeof resolveStripePriceCatalog>,
): {
	slices: Array<AdminInsightsPaidSlice>
	mrrUsdCents: number
	paidSubscribers: number
	unpricedPaidSubscribers: number
} {
	const byKey = new Map<string, AdminInsightsPaidSlice>()
	let paidSubscribers = 0
	let unpricedPaidSubscribers = 0
	let mrrUsdCents = 0

	for (const row of rows) {
		const subscribers = toCount(row.n)
		if (subscribers <= 0) continue
		const plan = row.stripe_plan === 'pro' ? 'pro' : 'standard'
		const entry = catalog.get(row.stripe_price_id)
		const interval = entry?.interval ?? 'unknown'
		const sliceMrr = entry
			? monthlyRecurringRevenueUsdCents(entry) * subscribers
			: 0
		if (!entry) unpricedPaidSubscribers += subscribers
		paidSubscribers += subscribers
		mrrUsdCents += sliceMrr
		const key = `${plan}:${interval}`
		const current = byKey.get(key) ?? {
			plan,
			interval,
			subscribers: 0,
			mrrUsdCents: 0,
		}
		current.subscribers += subscribers
		current.mrrUsdCents += sliceMrr
		byKey.set(key, current)
	}

	const slices = Array.from(byKey.values()).sort((left, right) => {
		if (left.plan !== right.plan) return left.plan.localeCompare(right.plan)
		return intervalRank(left.interval) - intervalRank(right.interval)
	})
	return { slices, mrrUsdCents, paidSubscribers, unpricedPaidSubscribers }
}

function intervalRank(interval: AdminInsightsPaidSlice['interval']) {
	switch (interval) {
		case 'month':
			return 0
		case 'year':
			return 1
		case 'unknown':
			return 2
		default: {
			const exhaustive: never = interval
			throw new Error(`Unknown billing interval: ${String(exhaustive)}`)
		}
	}
}

function foldMcpClients(
	rows: ReadonlyArray<NamedCountRow>,
): Array<AdminInsightsMcpClientSlice> {
	const byLabel = new Map<string, AdminInsightsMcpClientSlice>()
	for (const row of rows) {
		const count = toCount(row.n)
		if (count <= 0) continue
		const classified = classifyMcpClientName(row.name || null)
		const key = classified.kind ?? `other:${classified.label}`
		const current = byLabel.get(key) ?? {
			kind: classified.kind,
			label: classified.label,
			count: 0,
		}
		current.count += count
		byLabel.set(key, current)
	}
	return Array.from(byLabel.values()).sort(
		(left, right) =>
			right.count - left.count || left.label.localeCompare(right.label),
	)
}
