import { expect, test } from 'vitest'
import { type AccountUsageComputeOverage } from '#universal/loader-data.ts'
import { computeAccountUsageOverageNotice } from './account-usage.tsx'

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
				label: 'unique worker-days',
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
