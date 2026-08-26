import { expect, test, vi } from 'vitest'
import { createToastStore } from './toast.ts'

test('toast store auto-dismisses timed toasts, keeps persistent ones, replaces ids, and supports actions', () => {
	vi.useFakeTimers()
	try {
		const store = createToastStore()
		const listener = vi.fn()
		const unsubscribe = store.subscribe(listener)

		const successId = store.show('Avatar updated.', { tone: 'success' })
		expect(store.list()).toEqual([
			{
				id: successId,
				message: 'Avatar updated.',
				tone: 'success',
				duration: 4_000,
				dismissible: true,
			},
		])
		expect(listener).toHaveBeenCalledTimes(1)

		const errorId = store.show('Unable to upload avatar.', { tone: 'error' })
		expect(store.list().map((item) => item.id)).toEqual([successId, errorId])
		expect(store.list()[1]).toMatchObject({
			id: errorId,
			tone: 'error',
			duration: null,
			dismissible: true,
		})

		vi.advanceTimersByTime(4_000)
		expect(store.list().map((item) => item.id)).toEqual([errorId])
		expect(listener).toHaveBeenCalledTimes(3)

		store.show('Unable to upload avatar.', {
			id: errorId,
			tone: 'error',
			description: 'Try a smaller photo.',
		})
		expect(store.list()).toHaveLength(1)
		expect(store.list()[0]).toMatchObject({
			id: errorId,
			description: 'Try a smaller photo.',
		})

		const action = vi.fn()
		const undoId = store.show('Disconnected Personal.', {
			tone: 'info',
			duration: null,
			action: { label: 'Undo', onClick: action },
		})
		expect(store.list().at(-1)).toMatchObject({
			id: undoId,
			duration: null,
			action: { label: 'Undo', onClick: action },
		})

		store.dismiss(errorId)
		expect(store.list().map((item) => item.id)).toEqual([undoId])
		store.list()[0]?.action?.onClick()
		expect(action).toHaveBeenCalledTimes(1)

		store.dismiss()
		expect(store.list()).toEqual([])
		const callsAfterDismissAll = listener.mock.calls.length
		unsubscribe()
		store.show('Ignored after unsubscribe.', { duration: 1 })
		expect(listener).toHaveBeenCalledTimes(callsAfterDismissAll)
	} finally {
		vi.useRealTimers()
	}
})
