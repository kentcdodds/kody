import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	applyOutboundConsecutiveFailureTracking,
	clearOutboundDeliveryPause,
	outboundConsecutiveFailurePauseThreshold,
} from './outbound-consecutive-failures.ts'

function createOrgDb(initialFailures = 0, pausedAt: string | null = null) {
	const state = {
		failures: initialFailures,
		pausedAt,
	}
	const db = {
		prepare(sql: string) {
			return {
				bind(...binds: Array<unknown>) {
					return {
						async first<T>() {
							if (
								sql.includes('email_outbound_consecutive_failures + 1') &&
								sql.includes('RETURNING')
							) {
								state.failures += 1
								return {
									email_outbound_consecutive_failures: state.failures,
									email_outbound_delivery_paused_at: state.pausedAt,
								} as T
							}
							if (sql.includes('SELECT email_outbound_consecutive_failures')) {
								return {
									email_outbound_consecutive_failures: state.failures,
									email_outbound_delivery_paused_at: state.pausedAt,
								} as T
							}
							return null
						},
						async run() {
							if (
								sql.includes('email_outbound_delivery_paused_at = ?') &&
								sql.includes('email_outbound_consecutive_failures >= ?')
							) {
								if (
									state.pausedAt == null &&
									state.failures >= Number(binds[3])
								) {
									state.pausedAt = String(binds[0])
									return { meta: { changes: 1 } }
								}
								return { meta: { changes: 0 } }
							}
							if (
								sql.includes('email_outbound_consecutive_failures = 0') &&
								sql.includes('email_outbound_delivery_paused_at = NULL')
							) {
								const wasPaused = state.pausedAt != null
								state.failures = 0
								state.pausedAt = null
								return { meta: { changes: wasPaused ? 1 : 0 } }
							}
							if (sql.includes('email_outbound_consecutive_failures = 0')) {
								state.failures = 0
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db, state }
}

test('pauses after N consecutive terminal failures and clears on deliver or resume', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db, state } = createOrgDb()
	const ownerId = ownerIdFromStored('org_user_1')

	for (let i = 1; i < outboundConsecutiveFailurePauseThreshold; i++) {
		const result = await applyOutboundConsecutiveFailureTracking({
			db,
			ownerId,
			deliveryStatus: 'failed',
		})
		expect(result).toEqual({ paused: false, consecutiveFailures: i })
		expect(state.pausedAt).toBeNull()
	}

	const paused = await applyOutboundConsecutiveFailureTracking({
		db,
		ownerId,
		deliveryStatus: 'failed',
		now: new Date('2026-10-17T12:00:00.000Z'),
	})
	expect(paused.paused).toBe(true)
	expect(paused.consecutiveFailures).toBe(
		outboundConsecutiveFailurePauseThreshold,
	)
	expect(state.pausedAt).toBe('2026-10-17T12:00:00.000Z')

	await applyOutboundConsecutiveFailureTracking({
		db,
		ownerId,
		deliveryStatus: 'delivered',
	})
	expect(state.failures).toBe(0)
	expect(state.pausedAt).toBe('2026-10-17T12:00:00.000Z')

	expect(
		await clearOutboundDeliveryPause({
			db,
			ownerId,
			now: new Date('2026-10-17T13:00:00.000Z'),
		}),
	).toBe(true)
	expect(state.pausedAt).toBeNull()
	expect(state.failures).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-outbound-delivery-paused',
		expect.objectContaining({ consecutiveFailures: 5 }),
	)
})
