import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
} from '#universal/loader-data.ts'
import {
	UsageResourceName,
	computeAccountUsageOverageNotice,
	formatEntitlementUsedPercent,
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
	const percentOfLimit = overrides.percentOfLimit ?? 0.9
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
			},
		],
		disposition: 'dry_run',
		totalCents: 0,
		chargingEnabled: true,
		hasStripeCustomer: true,
		legacyUnbilled: false,
		...overrides,
	}
}

test('approaching notice mentions billing only while charging is enabled', () => {
	expect(
		computeAccountUsageOverageNotice(
			overage({ chargingEnabled: true, disposition: 'invoice' }),
		),
	).toMatchObject({
		title: 'Approaching compute includes',
	})
	expect(
		computeAccountUsageOverageNotice(
			overage({ chargingEnabled: false, disposition: 'dry_run' }),
		),
	).toMatchObject({
		title: 'Compute overage billing is paused',
	})
	expect(
		computeAccountUsageOverageNotice(
			overage({
				chargingEnabled: false,
				disposition: 'dry_run',
				percentOfLimit: 1.2,
			}),
		),
	).toMatchObject({
		title: 'Compute overage billing is paused',
	})
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
