import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
} from '#universal/loader-data.ts'
import {
	UsageResourceName,
	accountUsageWarningsPanelTitle,
	computeAccountUsageOverageNotice,
	creditsActionForWallet,
	warningOffersCredits,
	formatEntitlementUsedPercent,
	hasReachedEntitlementLimit,
	hotterUsagePercent,
} from './account-usage.tsx'

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
				label: 'Unique worker days',
				whatCounts: 'Counts distinct Dynamic Worker isolates.',
				howToReduce: 'Keep package code stable.',
				current: 45,
				include: 50,
				percentOfLimit,
				overEightyPercent: percentOfLimit >= 0.8,
				creditsStatus: percentOfLimit >= 1 ? 'add_credits' : 'within_include',
			},
		],
		creditWallet: 'empty',
		creditsStatus: 'within_include',
		creditsCostMicroUsd: 0,
		...rest,
	}
}

test('compute notice points capped accounts at credits, never at invoices', () => {
	const approaching = computeAccountUsageOverageNotice(overage({}), 'pro')
	expect(approaching).toMatchObject({
		title: 'Approaching compute includes',
		action: { label: 'Add credits', href: '/account/credits' },
	})

	const emptyWallet = computeAccountUsageOverageNotice(
		overage({ percentOfLimit: 1.2, creditsStatus: 'add_credits' }),
		'pro',
	)
	expect(emptyWallet).toMatchObject({
		tone: 'warn',
		action: { label: 'Add credits', href: '/account/credits' },
	})

	const free = computeAccountUsageOverageNotice(
		overage({
			percentOfLimit: 1.2,
			creditWallet: 'none',
			creditsStatus: 'switch_to_pro',
		}),
		'free',
	)
	expect(free).toMatchObject({
		body: 'Switch to Pro for a larger include and prepaid credits.',
		action: { label: 'Switch to Pro', href: '/account/credits' },
	})

	const funded = computeAccountUsageOverageNotice(
		overage({
			percentOfLimit: 1.5,
			creditWallet: 'funded',
			creditsStatus: 'debiting_credits',
			creditsCostMicroUsd: 1_240_000,
		}),
		'pro',
	)
	expect(funded).toMatchObject({ title: 'Using credits', action: null })
	expect(funded?.body).toContain('$1.24')

	for (const notice of [approaching, emptyWallet, free, funded]) {
		expect(notice?.body).not.toMatch(/invoice|billed|payment method|overage/i)
	}

	expect(
		computeAccountUsageOverageNotice(overage({ percentOfLimit: 0.2 }), 'pro'),
	).toBeNull()
	expect(
		computeAccountUsageOverageNotice(
			overage({
				percentOfLimit: 1.5,
				creditWallet: 'none',
				creditsStatus: 'not_charged',
			}),
			'max',
		),
	).toBeNull()
})

test('credits action follows the wallet: add, switch, or nothing', () => {
	expect(creditsActionForWallet('empty', 'pro')).toEqual({
		label: 'Add credits',
		href: '/account/credits',
	})
	expect(creditsActionForWallet('none', 'standard')).toEqual({
		label: 'Switch to Pro',
		href: '/account/credits',
	})
	expect(creditsActionForWallet('funded', 'pro')).toBeNull()
	expect(creditsActionForWallet('none', 'max')).toBeNull()
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
		resource: 'unique_worker_days',
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
