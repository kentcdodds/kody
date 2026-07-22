import { expect, test, vi } from 'vitest'
import {
	isInvalidOAuthPurgeCursorError,
	listOAuthPurgePage,
} from './oauth-purge.ts'

test('OAuth purge restarts invalid cursors and preserves unrelated list errors', async () => {
	const recoveredPage = {
		list_complete: true,
		keys: [{ name: 'grant:user:grant' }],
		cacheStatus: null,
	} satisfies KVNamespaceListResult<unknown>
	const invalidCursorError = new Error('KV LIST failed: 400 Invalid cursor')
	const list = vi
		.fn()
		.mockRejectedValueOnce(invalidCursorError)
		.mockResolvedValueOnce(recoveredPage)
	const kv = { list } as unknown as KVNamespace

	await expect(
		listOAuthPurgePage(kv, {
			prefix: 'grant:',
			cursor: 'expired-cursor',
		}),
	).resolves.toBe(recoveredPage)
	expect(list).toHaveBeenNthCalledWith(1, {
		prefix: 'grant:',
		cursor: 'expired-cursor',
		limit: 50,
	})
	expect(list).toHaveBeenNthCalledWith(2, {
		prefix: 'grant:',
		limit: 50,
	})

	const unrelatedError = new Error('KV LIST failed: upstream connection reset')
	list.mockReset()
	list.mockRejectedValueOnce(unrelatedError)
	await expect(
		listOAuthPurgePage(kv, {
			prefix: 'token:',
			cursor: 'still-present',
		}),
	).rejects.toBe(unrelatedError)
	expect(list).toHaveBeenCalledTimes(1)

	expect(
		isInvalidOAuthPurgeCursorError(
			new Error('KV LIST failed', {
				cause: new Error('cursor expired'),
			}),
		),
	).toBe(true)
})
