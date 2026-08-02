import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { recordMailboxParityEvent } from './mailbox-parity-events.ts'

test('mailbox parity writes compact indexed mirror and parity data points', () => {
	const writeDataPoint = vi.fn()
	const env = {
		EMAIL_EVENTS: {
			writeDataPoint,
		} as unknown as AnalyticsEngineDataset,
	}

	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'mirror_message',
		outcome: 'mirrored',
		timestamp: '2026-07-30T10:00:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-2',
		category: 'parity',
		operation: 'compare_messages',
		outcome: 'mismatch',
		d1Count: 12,
		doCount: 10,
		timestamp: '2026-07-30T11:00:00.000Z',
	})

	expect(writeDataPoint).toHaveBeenCalledTimes(2)
	expect(writeDataPoint).toHaveBeenCalledWith({
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:mirror_message',
			'mirrored',
			'2026-07-30T10:00:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenCalledWith({
		indexes: ['user-2'],
		blobs: [
			'mailbox_parity:compare_messages',
			'mismatch',
			'2026-07-30T11:00:00.000Z',
		],
		doubles: [1, 2],
	})
})

test('mailbox parity skips system email and never throws when the binding is absent or fails', () => {
	const writeDataPoint = vi.fn()
	consoleWarn.mockImplementation(() => {})

	recordMailboxParityEvent(
		{
			EMAIL_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			userId: systemEmailOwnerId,
			category: 'mirror',
			operation: 'mirror_message',
			outcome: 'mirrored',
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()

	recordMailboxParityEvent(
		{
			EMAIL_EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
		},
		{
			userId: '',
			category: 'mirror',
			operation: 'mirror_message',
			outcome: 'mirrored',
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()

	expect(() =>
		recordMailboxParityEvent(
			{},
			{
				userId: 'user-1',
				category: 'mirror',
				operation: 'update_message_delivery',
				outcome: 'mirrored',
			},
		),
	).not.toThrow()

	expect(() =>
		recordMailboxParityEvent(
			{
				EMAIL_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{
				userId: 'user-1',
				category: 'parity',
				operation: 'compare_delivery_events',
				outcome: 'mismatch',
				d1Count: 3,
				doCount: 1,
			},
		),
	).not.toThrow()

	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-parity-event-write-failed',
		expect.objectContaining({ message: 'analytics unavailable' }),
	)
})
