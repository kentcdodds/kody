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
		userId: 'user-1',
		category: 'mirror',
		operation: 'touch_thread',
		outcome: 'stale',
		timestamp: '2026-07-30T10:05:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'set_message_classification',
		outcome: 'missing',
		timestamp: '2026-07-30T10:06:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'delete_message_metadata',
		outcome: 'timeout',
		timestamp: '2026-07-30T10:07:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'touch_thread',
		outcome: 'skipped',
		timestamp: '2026-07-30T10:08:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'upsert_delivery_event',
		outcome: 'error',
		timestamp: '2026-07-30T10:09:00.000Z',
	})
	recordMailboxParityEvent(env, {
		userId: 'user-1',
		category: 'mirror',
		operation: 'upsert_delivery_event_batch',
		outcome: 'timeout',
		timestamp: '2026-07-30T10:10:00.000Z',
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
	recordMailboxParityEvent(env, {
		userId: 'user-3',
		category: 'parity',
		operation: 'compare_threads',
		outcome: 'match',
		timestamp: '2026-07-30T12:00:00.000Z',
	})

	expect(writeDataPoint).toHaveBeenCalledTimes(9)
	expect(writeDataPoint).toHaveBeenNthCalledWith(1, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:mirror_message',
			'mirrored',
			'2026-07-30T10:00:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(2, {
		indexes: ['user-1'],
		blobs: ['mailbox_mirror:touch_thread', 'stale', '2026-07-30T10:05:00.000Z'],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(3, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:set_message_classification',
			'missing',
			'2026-07-30T10:06:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(4, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:delete_message_metadata',
			'timeout',
			'2026-07-30T10:07:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(5, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:touch_thread',
			'skipped',
			'2026-07-30T10:08:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(6, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:upsert_delivery_event',
			'error',
			'2026-07-30T10:09:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(7, {
		indexes: ['user-1'],
		blobs: [
			'mailbox_mirror:upsert_delivery_event_batch',
			'timeout',
			'2026-07-30T10:10:00.000Z',
		],
		doubles: [1, 0],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(8, {
		indexes: ['user-2'],
		blobs: [
			'mailbox_parity:compare_messages',
			'mismatch',
			'2026-07-30T11:00:00.000Z',
		],
		doubles: [1, 2],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(9, {
		indexes: ['user-3'],
		blobs: [
			'mailbox_parity:compare_threads',
			'match',
			'2026-07-30T12:00:00.000Z',
		],
		doubles: [1, 0],
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
