import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { mirrorMailboxMessageGraphFromD1 } from './mailbox-live-mirror.ts'

test('retired D1-to-Mailbox USER rebuild is blocked before preparing frozen graph SQL', async () => {
	consoleWarn.mockImplementation(() => {})
	const prepare = vi.fn()

	const result = await mirrorMailboxMessageGraphFromD1({
		env: {} as never,
		db: { prepare } as unknown as D1Database,
		userId: 'user-1',
		messageId: 'message-1',
	})

	expect(result.message).toMatchObject({ status: 'error' })
	expect(prepare).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-live-mirror-message-graph-failed',
		expect.objectContaining({
			message: expect.stringContaining(
				'Legacy USER D1 email graph operation is disabled',
			),
		}),
	)
})
