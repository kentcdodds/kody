import { expect, test, vi } from 'vitest'
import {
	getRecoveryBookmark,
	pitrUnavailableCode,
	restoreToBookmark,
} from './do-pitr.ts'

test('Durable Object PITR resolves bookmarks, returns and logs the undo handle, then aborts', async () => {
	const getBookmarkForTime = vi.fn<
		(timestamp: number | Date) => Promise<string>
	>(async () => 'bookmark-at-time')
	const onNextSessionRestoreBookmark = vi.fn<
		(bookmark: string) => Promise<string>
	>(async () => 'undo-bookmark')
	const abort = vi.fn<(reason?: string) => void>()
	const logger = { log: vi.fn<(message: string) => void>() }
	let scheduledAbort: (() => void) | undefined
	const ctx = {
		storage: {
			getBookmarkForTime,
			onNextSessionRestoreBookmark,
		},
		abort,
	}

	await expect(
		getRecoveryBookmark(ctx, { timestampMs: 1_786_000_000_000 }),
	).resolves.toEqual({ bookmark: 'bookmark-at-time' })
	expect(getBookmarkForTime).toHaveBeenCalledWith(1_786_000_000_000)

	await expect(
		restoreToBookmark(
			ctx,
			{ bookmark: 'bookmark-at-time' },
			{
				objectKind: 'mailbox',
				logger,
				scheduleAbort: (reset) => {
					scheduledAbort = reset
				},
			},
		),
	).resolves.toEqual({ undoBookmark: 'undo-bookmark' })
	expect(onNextSessionRestoreBookmark).toHaveBeenCalledWith('bookmark-at-time')
	expect(logger.log).toHaveBeenCalledTimes(1)
	expect(JSON.parse(String(logger.log.mock.calls[0]?.[0]))).toEqual({
		event: 'do-pitr-restore-scheduled',
		objectKind: 'mailbox',
		targetBookmark: 'bookmark-at-time',
		undoBookmark: 'undo-bookmark',
	})
	expect(abort).not.toHaveBeenCalled()

	scheduledAbort?.()
	expect(abort).toHaveBeenCalledWith(
		'Applying scheduled Durable Object PITR restore.',
	)
})

test('Durable Object PITR degrades clearly when the runtime API is unavailable', async () => {
	const unavailableContext = {
		storage: {},
		abort: vi.fn<(reason?: string) => void>(),
	}

	await expect(
		getRecoveryBookmark(unavailableContext, { timestampMs: Date.now() }),
	).rejects.toMatchObject({
		code: pitrUnavailableCode,
		message: expect.stringContaining(pitrUnavailableCode),
	})
	await expect(
		restoreToBookmark(
			unavailableContext,
			{ bookmark: 'bookmark' },
			{ objectKind: 'storage-runner' },
		),
	).rejects.toMatchObject({
		code: pitrUnavailableCode,
		message: expect.stringContaining(pitrUnavailableCode),
	})
})
