import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { recordEmailReportingEvent } from './reporting-events.ts'

test('email reporting writes compact indexed send, receive, and delivery data points', () => {
	const writeDataPoint = vi.fn()
	const env = {
		EMAIL_EVENTS: {
			writeDataPoint,
		} as unknown as AnalyticsEngineDataset,
	}

	recordEmailReportingEvent(env, {
		userId: 'user-1',
		eventType: 'email_send',
		timestamp: '2026-07-30T10:00:00.000Z',
	})
	recordEmailReportingEvent(env, {
		userId: 'user-2',
		eventType: 'email_receive',
		timestamp: '2026-07-30T11:00:00.000Z',
	})
	recordEmailReportingEvent(env, {
		userId: 'user-1',
		eventType: 'email_delivery',
		outcome: 'bounced',
		timestamp: '2026-07-31T00:00:00.000Z',
	})

	expect(writeDataPoint).toHaveBeenCalledTimes(3)
	expect(writeDataPoint).toHaveBeenNthCalledWith(1, {
		indexes: ['user-1'],
		blobs: ['email_send', '', '2026-07-30T10:00:00.000Z'],
		doubles: [1],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(2, {
		indexes: ['user-2'],
		blobs: ['email_receive', '', '2026-07-30T11:00:00.000Z'],
		doubles: [1],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(3, {
		indexes: ['user-1'],
		blobs: ['email_delivery', 'bounced', '2026-07-31T00:00:00.000Z'],
		doubles: [1],
	})
})

test('email reporting never throws when the binding is absent or fails', () => {
	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordEmailReportingEvent(
			{},
			{
				userId: 'user-1',
				eventType: 'email_send',
			},
		),
	).not.toThrow()
	expect(() =>
		recordEmailReportingEvent(
			{
				EMAIL_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{
				userId: 'user-1',
				eventType: 'email_delivery',
				outcome: 'failed',
			},
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-reporting-event-write-failed',
		expect.objectContaining({ message: 'analytics unavailable' }),
	)
})
