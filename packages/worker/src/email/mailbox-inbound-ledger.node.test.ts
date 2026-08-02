import { expect, test } from 'vitest'
import {
	assertMailboxInboundNonNegativeFiniteNumber,
	resolveMailboxSubscriptionEffectFailure,
	needsMailboxEffectReconcile,
	mailboxInboundStorageLeaseMs,
	mailboxMaxSubscriptionEffectAttempts,
} from './mailbox-inbound-ledger.ts'
import { resolveSubscriptionEffectFailure } from './inbound-effects.ts'

test('subscription effect failure matrix matches D1 resolveSubscriptionEffectFailure', () => {
	for (const attempt of [0, 1, 2, 3, 10]) {
		expect(resolveMailboxSubscriptionEffectFailure(attempt)).toEqual(
			resolveSubscriptionEffectFailure(attempt),
		)
	}
	expect(mailboxMaxSubscriptionEffectAttempts).toBe(3)
	expect(resolveMailboxSubscriptionEffectFailure(2).deadLettered).toBe(true)
	expect(resolveMailboxSubscriptionEffectFailure(1).deadLettered).toBe(false)
})

test('effect reconcile flag parity matches D1 needs_effect_reconcile cases', () => {
	expect(
		needsMailboxEffectReconcile({
			usageEffectRecordedAt: '2026-07-01T00:00:00.000Z',
			subscriptionEffectState: 'complete',
		}),
	).toBe(false)
	expect(
		needsMailboxEffectReconcile({
			usageEffectSuppressedAt: '2026-07-01T00:00:00.000Z',
			subscriptionEffectState: 'dead-letter',
		}),
	).toBe(false)
	expect(
		needsMailboxEffectReconcile({
			usageEffectRecordedAt: '2026-07-01T00:00:00.000Z',
			subscriptionEffectState: 'pending',
		}),
	).toBe(true)
	expect(
		needsMailboxEffectReconcile({
			subscriptionEffectState: 'complete',
		}),
	).toBe(true)
	expect(needsMailboxEffectReconcile({})).toBe(true)
})

test('storage lease takeover predicate matches D1 stale window', () => {
	const now = Date.parse('2026-07-22T00:00:00.000Z')
	const freshLeaseAt = new Date(
		now - mailboxInboundStorageLeaseMs + 1,
	).toISOString()
	const staleLeaseAt = new Date(
		now - mailboxInboundStorageLeaseMs - 1,
	).toISOString()
	const expiredBefore = new Date(
		now - mailboxInboundStorageLeaseMs,
	).toISOString()
	expect(freshLeaseAt < expiredBefore).toBe(false)
	expect(staleLeaseAt < expiredBefore).toBe(true)
})

test('assertMailboxInboundNonNegativeFiniteNumber rejects invalid values', () => {
	for (const value of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-1,
	]) {
		for (const label of [
			'expectedAttachmentCount',
			'usageDurationMs',
			'usageBytes',
		] as const) {
			expect(() =>
				assertMailboxInboundNonNegativeFiniteNumber(value, label),
			).toThrow(new RegExp(`${label} must be a non-negative finite number`))
		}
	}
	expect(assertMailboxInboundNonNegativeFiniteNumber(0, 'usageBytes')).toBe(0)
	expect(
		assertMailboxInboundNonNegativeFiniteNumber(12.5, 'usageDurationMs'),
	).toBe(12.5)
})
