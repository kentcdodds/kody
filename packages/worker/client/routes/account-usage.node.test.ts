import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { warningOffersCredits } from '#universal/compute-overage.ts'
import { expect, test } from 'vitest'
import { AppSessionProvider } from '#client/app-session-context.tsx'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { type SessionInfo } from '#client/session.ts'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	includedComputeSummary,
	presentIncludedCompute,
	resolveCreditsAlarm,
	toAccountActivity,
} from '#universal/usage-presentation.ts'
import {
	AccountUsageRoute,
	UsageResourceName,
	accountUsageWarningsPanelTitle,
	formatEntitlementUsedPercent,
	hasReachedEntitlementLimit,
	hotterUsagePercent,
} from './account-usage.tsx'
import { creditsActionForWallet } from './account-usage-shared.ts'

function entitlement(
	overrides: Partial<AccountUsageEntitlementConsumption> = {},
): AccountUsageEntitlementConsumption {
	return {
		resource: 'execute_calls_per_day',
		label: 'execute calls per day',
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Execute calls today (UTC).',
		howToReduce: 'Run fewer execute calls today or this week.',
		current: 30,
		limit: 150,
		percentOfLimit: 0.2,
		overEightyPercent: false,
		...overrides,
	}
}

function overage(
	overrides: Partial<AccountUsageComputeOverage> & {
		percentOfLimit?: number
	},
): AccountUsageComputeOverage {
	const { percentOfLimit = 0.9, ...rest } = overrides
	return {
		meters: [
			{
				resource: 'unique_worker_days',
				label: 'Worker compute',
				whatCounts: 'Counts each distinct worker once per UTC day.',
				howToReduce: 'Keep package code stable.',
				current: 45,
				include: 50,
				percentOfLimit,
				overEightyPercent: percentOfLimit >= 0.8,
				creditsStatus: percentOfLimit >= 1 ? 'add_credits' : 'within_include',
			},
			{
				resource: 'durable_object_rows_read',
				label: 'Rows read',
				whatCounts: 'SQLite rows read by Durable Object package storage.',
				howToReduce: 'Read less from package storage.',
				current: 450_000_000,
				include: 500_000_000,
				percentOfLimit: Math.min(percentOfLimit, 0.9),
				overEightyPercent: percentOfLimit >= 0.8,
				creditsStatus: 'within_include',
			},
		],
		creditWallet: 'empty',
		creditsStatus: 'within_include',
		creditsCostMicroUsd: 0,
		...rest,
	}
}

test('credits action follows the wallet: add, switch, or nothing', () => {
	expect(creditsActionForWallet('empty', 'pro', true)).toEqual({
		label: 'Add credits',
		href: '/account/credits',
	})
	expect(creditsActionForWallet('none', 'standard', false)).toEqual({
		label: 'Switch to Pro',
		href: '/account/credits',
	})
	expect(creditsActionForWallet('funded', 'pro', true)).toBeNull()
	expect(creditsActionForWallet('none', 'max', false)).toBeNull()
})

test('gift and referral Pro overlays have no wallet (retired Pro ceilings)', () => {
	expect(creditsActionForWallet('none', 'pro', false)).toEqual({
		label: 'Switch to Pro',
		href: '/account/credits',
	})
})

test('empty wallet without purchase rights still points at Subscribe to Pro', () => {
	expect(creditsActionForWallet('empty', 'pro', false)).toEqual({
		label: 'Subscribe to Pro',
		href: '/account/credits',
	})
})

test('warning credits links only on limits credits can raise', () => {
	for (const resource of [
		'execute_calls_per_day',
		'outbound_fetches_per_day',
		'job_runs_per_day',
		'automation_invocations_per_day',
		'unique_worker_days',
		'durable_object_rows_read',
	]) {
		expect(warningOffersCredits(resource)).toBe(true)
	}
	for (const resource of [
		'saved_packages',
		'secrets',
		'email_sends_per_day',
		'storage_bytes',
		'concurrent_workflows',
	]) {
		expect(warningOffersCredits(resource)).toBe(false)
	}
})

test('hotterUsagePercent uses the closer of daily and weekly windows', () => {
	expect(hotterUsagePercent(entitlement())).toBe(0.2)
	expect(
		hotterUsagePercent(
			entitlement({
				week: {
					current: 360,
					limit: 400,
					percentOfLimit: 0.9,
					overEightyPercent: true,
				},
			}),
		),
	).toBe(0.9)
	expect(
		hotterUsagePercent(
			entitlement({
				percentOfLimit: 0.95,
				week: {
					current: 100,
					limit: 400,
					percentOfLimit: 0.25,
					overEightyPercent: false,
				},
			}),
		),
	).toBe(0.95)
	expect(
		hotterUsagePercent(entitlement({ percentOfLimit: null, week: undefined })),
	).toBeNull()
})

test('usage resource name keeps the explanation in a popover', async () => {
	const whatCounts = 'MCP execute tool runs today (UTC).'
	const html = await renderToString(
		jsx(UsageResourceName, {
			id: 'execute_calls_per_day',
			label: 'Execute calls',
			whatCounts,
			howToReduce: 'Run fewer execute calls today or this week.',
			note: 'High daily headroom for bursts; the weekly total keeps it sustainable.',
		}),
	)
	expect(html).toContain('>Execute calls</span>')
	expect(html).toContain('popovertarget="usage-resource-execute_calls_per_day"')
	expect(html).toContain('aria-label="What counts toward Execute calls"')
	const panelAt = html.indexOf(
		'data-usage-resource-panel="execute_calls_per_day"',
	)
	expect(panelAt).toBeGreaterThan(-1)
	expect(html.slice(panelAt)).toContain(whatCounts)
	expect(html.slice(0, panelAt)).not.toContain(whatCounts)
})

test('formatEntitlementUsedPercent shows today and this week', () => {
	expect(formatEntitlementUsedPercent(entitlement())).toBe('20%')
	expect(
		formatEntitlementUsedPercent(
			entitlement({
				week: {
					current: 360,
					limit: 400,
					percentOfLimit: 0.9,
					overEightyPercent: true,
				},
			}),
		),
	).toBe('20% today · 90% this week')
})

test('warnings panel title is Limit reached at 100% daily or weekly', () => {
	expect(
		accountUsageWarningsPanelTitle([
			entitlement({
				percentOfLimit: 0.85,
				overEightyPercent: true,
			}),
		]),
	).toBe('Approaching limits')
	expect(
		hasReachedEntitlementLimit(
			entitlement({
				percentOfLimit: 0.85,
				overEightyPercent: true,
			}),
		),
	).toBe(false)

	const weeklyAtLimit = entitlement({
		percentOfLimit: 0.2,
		overEightyPercent: true,
		week: {
			current: 400,
			limit: 400,
			percentOfLimit: 1,
			overEightyPercent: true,
		},
	})
	expect(hasReachedEntitlementLimit(weeklyAtLimit)).toBe(true)
	expect(accountUsageWarningsPanelTitle([weeklyAtLimit])).toBe('Limit reached')

	expect(
		accountUsageWarningsPanelTitle([
			entitlement({
				percentOfLimit: 1,
				overEightyPercent: true,
			}),
		]),
	).toBe('Limit reached')

	const computeIncludeAtLimit = entitlement({
		resource: 'durable_object_rows_read',
		group: 'monthly',
		percentOfLimit: 1,
		overEightyPercent: true,
	})
	expect(hasReachedEntitlementLimit(computeIncludeAtLimit)).toBe(false)
	expect(accountUsageWarningsPanelTitle([computeIncludeAtLimit])).toBe(
		'Approaching limits',
	)
	expect(
		accountUsageWarningsPanelTitle([computeIncludeAtLimit, weeklyAtLimit]),
	).toBe('Limit reached')
})

const session: SessionInfo = {
	email: 'danj@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'danj',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

function usagePage(input: {
	plan: AccountUsageLoaderData['plan']
	computeOverage: AccountUsageComputeOverage
	balanceMicroUsd?: number
	canBuyCredits?: boolean
	entitlementConsumption?: Array<AccountUsageEntitlementConsumption>
	warnings?: Array<AccountUsageEntitlementConsumption>
}): AccountUsageLoaderData {
	const includedCompute = presentIncludedCompute({
		plan: input.plan,
		creditWallet: input.computeOverage.creditWallet,
		meters: input.computeOverage.meters,
	})
	const canBuyCredits = input.canBuyCredits ?? false
	return {
		ok: true,
		plan: input.plan,
		manualPlan: input.plan,
		stripePlan: null,
		today: '2026-09-27',
		weekStart: '2026-09-21',
		entitlementConsumption: input.entitlementConsumption ?? [entitlement()],
		warnings: input.warnings ?? [],
		computeOverage: input.computeOverage,
		canBuyCredits,
		activity: toAccountActivity({
			month: '2026-09',
			counts: { execute: 140, job_run: 3 },
		}),
		includedCompute,
		includedComputeSummary: includedComputeSummary({
			plan: input.plan,
			creditWallet: input.computeOverage.creditWallet,
			meters: includedCompute,
		}),
		creditsAlarm: resolveCreditsAlarm({
			creditWallet: input.computeOverage.creditWallet,
			meters: includedCompute,
			balanceMicroUsd: input.balanceMicroUsd ?? 0,
			canBuyCredits,
			autoRefill: null,
		}),
	}
}

async function renderUsagePage(accountUsage: AccountUsageLoaderData) {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: routes.accountUsage.href(),
			children: jsx(AppSessionProvider, {
				session,
				status: 'ready',
				children: jsx(AppLoaderDataProvider, {
					loaderData: { accountUsage },
					children: jsx(AccountUsageRoute, {}),
				}),
			}),
		}),
	)
	const text = html
		.replaceAll(/<style[\s\S]*?<\/style>/g, ' ')
		.replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
		.replaceAll(/<[^>]+>/g, ' ')
	return { html, text }
}

const overHundredPercent = /\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/

test('Free usage page: activity and execute caps lead; Worker compute is informational, never a mega-%', async () => {
	const freeOverage = overage({
		creditWallet: 'none',
		creditsStatus: 'switch_to_pro',
	})
	freeOverage.meters[0] = {
		...freeOverage.meters[0]!,
		current: 517,
		include: 50,
		percentOfLimit: 517 / 50,
		overEightyPercent: true,
		creditsStatus: 'switch_to_pro',
	}
	const { html, text } = await renderUsagePage(
		usagePage({ plan: 'free', computeOverage: freeOverage }),
	)
	expect(text).toContain('Activity this month')
	expect(text).toContain('Code executions')
	expect(text).toContain('Free is limited by daily and weekly execute caps')
	expect(text).toContain('Behind the scenes')
	expect(text).toContain('517 worker-compute days this month')
	expect(text).toContain('Informational · never charged on Free')
	expect(html).not.toContain('data-included-compute-bar')
	expect(html).not.toContain('data-credits-alarm')
	expect(text).not.toContain('1034%')
	expect(text).not.toMatch(overHundredPercent)
	expect(text).not.toMatch(/Over this month's include|overage/i)
	expect(text).not.toMatch(/unique worker day|\bUWD\b|\bMax\b/i)
	expect(html.indexOf('Activity this month')).toBeLessThan(
		html.indexOf('Behind the scenes'),
	)
})

test('Pro usage page past include matches credits: capped bar, dollars on credits, no alarm', async () => {
	const fundedOverage = overage({
		creditWallet: 'funded',
		creditsStatus: 'debiting_credits',
		creditsCostMicroUsd: 173_672_000,
	})
	fundedOverage.meters[0] = {
		...fundedOverage.meters[0]!,
		current: 43_768,
		include: 350,
		percentOfLimit: 43_768 / 350,
		overEightyPercent: true,
		creditsStatus: 'debiting_credits',
	}
	const { html, text } = await renderUsagePage(
		usagePage({
			plan: 'pro',
			computeOverage: fundedOverage,
			balanceMicroUsd: 40_000_000,
			canBuyCredits: true,
		}),
	)
	expect(text).toContain('Included compute')
	expect(html).toContain('data-included-compute-bar="100"')
	expect(text).toContain('Include used · $173.67 on credits')
	expect(text).toContain('43,768 of 350 worker-compute days included')
	expect(html).not.toContain('data-credits-alarm')
	expect(text).not.toContain('12505%')
	expect(text).not.toMatch(overHundredPercent)
	expect(text).not.toMatch(/unique worker day|\bUWD\b|\bMax\b/i)
})

test('Pro usage page with no credits past include raises the stop alarm', async () => {
	const emptyOverage = overage({
		percentOfLimit: 1.2,
		creditsStatus: 'add_credits',
	})
	emptyOverage.meters[0] = { ...emptyOverage.meters[0]!, current: 60 }
	const { html, text } = await renderUsagePage(
		usagePage({
			plan: 'pro',
			computeOverage: emptyOverage,
			canBuyCredits: true,
		}),
	)
	expect(html).toContain('data-credits-alarm="include_used_no_credits"')
	expect(text).toContain('Runs past the include are stopped')
	expect(html).toMatch(/href="\/account\/credits"[^>]*>Add credits</)
	expect(text).not.toMatch(overHundredPercent)
})
