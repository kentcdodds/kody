import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { warningOffersCredits } from '#universal/compute-overage.ts'
import { expect, test } from 'vitest'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
} from '#universal/loader-data.ts'
import {
	UsageResourceName,
	accountUsageWarningsPanelTitle,
	formatEntitlementUsedPercent,
	hasReachedEntitlementLimit,
	hotterUsagePercent,
	renderMeterCreditsStatus,
} from './account-usage.tsx'
import {
	computeAccountUsageOverageNotice,
	creditsActionForWallet,
} from './account-usage-shared.ts'

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
	const approaching = computeAccountUsageOverageNotice(overage({}), 'pro', true)
	expect(approaching).toMatchObject({
		title: 'Approaching compute includes',
		action: { label: 'Add credits', href: '/account/credits' },
	})

	const emptyWallet = computeAccountUsageOverageNotice(
		overage({ percentOfLimit: 1.2, creditsStatus: 'add_credits' }),
		'pro',
		true,
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
		false,
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
		true,
	)
	expect(funded).toMatchObject({ title: 'Using credits', action: null })
	expect(funded?.body).toContain('$1.24')

	for (const notice of [approaching, emptyWallet, free, funded]) {
		expect(notice?.body).not.toMatch(/invoice|billed|payment method|overage/i)
	}

	expect(
		computeAccountUsageOverageNotice(
			overage({ percentOfLimit: 0.2 }),
			'pro',
			true,
		),
	).toBeNull()
	expect(
		computeAccountUsageOverageNotice(
			overage({
				percentOfLimit: 1.5,
				creditWallet: 'none',
				creditsStatus: 'not_charged',
			}),
			'max',
			false,
		),
	).toBeNull()
})

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
	const approaching = computeAccountUsageOverageNotice(
		overage({
			creditWallet: 'none',
			creditsStatus: 'within_include',
			percentOfLimit: 0.85,
		}),
		'pro',
		false,
	)
	expect(approaching).toMatchObject({
		action: { label: 'Switch to Pro', href: '/account/credits' },
	})
})

test('empty wallet without purchase rights still points at Subscribe to Pro', () => {
	expect(creditsActionForWallet('empty', 'pro', false)).toEqual({
		label: 'Subscribe to Pro',
		href: '/account/credits',
	})
	const capped = computeAccountUsageOverageNotice(
		overage({ percentOfLimit: 1.2, creditsStatus: 'add_credits' }),
		'pro',
		false,
	)
	expect(capped).toMatchObject({
		body: 'Subscribe to Pro to add credits and lift rate caps.',
		action: { label: 'Subscribe to Pro', href: '/account/credits' },
	})
})

test('meter credits column offers the purchase the account can make', async () => {
	const meterCell = (canBuyCredits: boolean) =>
		renderToString(
			jsx('span', {
				children: renderMeterCreditsStatus('add_credits', canBuyCredits),
			}),
		)
	expect(await meterCell(true)).toContain('>Add credits</a>')
	const gift = await meterCell(false)
	expect(gift).toContain('>Subscribe to Pro</a>')
	expect(gift).not.toContain('Add credits')
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
