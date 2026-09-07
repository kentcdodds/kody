import { expect, test } from 'vitest'
import { isStripePaidPlan, isStrongRecentUse } from './campaign-inputs.ts'
import {
	campaignClientLabel,
	isPackagedSingleClientTrialCtaLive,
} from './campaign-states.ts'

test('campaign inputs treat Stripe Standard/Pro as paid and require execute depth for strong use', () => {
	expect(isStripePaidPlan('standard')).toBe(true)
	expect(isStripePaidPlan('pro')).toBe(true)
	expect(isStripePaidPlan('free')).toBe(false)
	expect(isStripePaidPlan('max')).toBe(false)
	expect(isStripePaidPlan(null)).toBe(false)

	const now = new Date('2026-09-07T12:00:00.000Z')
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: '2026-09-02T00:00:00.000Z',
			executeCount: 3,
			now,
		}),
	).toBe(true)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: '2026-09-02T00:00:00.000Z',
			executeCount: 2,
			now,
		}),
	).toBe(false)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-08-01T00:00:00.000Z',
			firstExecuteAt: '2026-08-01T00:00:00.000Z',
			executeCount: 20,
			now,
		}),
	).toBe(false)
	expect(
		isStrongRecentUse({
			lastActiveAt: '2026-09-06T00:00:00.000Z',
			firstExecuteAt: null,
			executeCount: 10,
			now,
		}),
	).toBe(false)

	expect(campaignClientLabel(null)).toBe('your agent')
	expect(campaignClientLabel('Cursor')).toBe('Cursor')
	expect(isPackagedSingleClientTrialCtaLive({})).toBe(true)
	expect(
		isPackagedSingleClientTrialCtaLive({
			grantedAt: '2026-09-01T00:00:00.000Z',
			expiresAt: '2026-09-15T00:00:00.000Z',
			now: new Date('2026-09-07T12:00:00.000Z'),
		}),
	).toBe(false)
})
