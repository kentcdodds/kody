import { expect, test, vi } from 'vitest'

const { createUndoableAction } = await import('./undoable-action.ts')

function createHandle() {
	const abort = new AbortController()
	return {
		update: vi.fn(),
		signal: abort.signal,
		abort: () => abort.abort(),
	}
}

test('undoable action commits after the timeout, undoes before it, and commits a replaced or aborted pending action', async () => {
	vi.useFakeTimers()
	try {
		const handle = createHandle()
		const undoable = createUndoableAction(handle as never, { timeoutMs: 1_000 })
		const firstCommit = vi.fn()
		const firstUndo = vi.fn()

		await undoable.start({
			message: 'Disconnected Personal.',
			onCommit: firstCommit,
			onUndo: firstUndo,
		})
		expect(undoable.pending).toEqual({
			message: 'Disconnected Personal.',
			undoLabel: 'Undo',
		})
		expect(handle.update).toHaveBeenCalled()

		await undoable.undo()
		expect(firstUndo).toHaveBeenCalledTimes(1)
		expect(firstCommit).not.toHaveBeenCalled()
		expect(undoable.pending).toBeNull()

		const timedCommit = vi.fn()
		await undoable.start({
			message: 'Disconnected Work.',
			undoLabel: 'Restore',
			onCommit: timedCommit,
		})
		expect(undoable.pending?.undoLabel).toBe('Restore')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(timedCommit).toHaveBeenCalledTimes(1)
		expect(undoable.pending).toBeNull()

		const replacedCommit = vi.fn()
		const nextCommit = vi.fn()
		await undoable.start({
			message: 'Disconnected first.',
			onCommit: replacedCommit,
		})
		await undoable.start({
			message: 'Deleted Google.',
			onCommit: nextCommit,
		})
		expect(replacedCommit).toHaveBeenCalledTimes(1)
		expect(nextCommit).not.toHaveBeenCalled()
		expect(undoable.pending?.message).toBe('Deleted Google.')

		const abortHandle = createHandle()
		const abortable = createUndoableAction(abortHandle as never, {
			timeoutMs: 5_000,
		})
		const abortCommit = vi.fn()
		await abortable.start({
			message: 'Disconnected abort.',
			onCommit: abortCommit,
		})
		abortHandle.abort()
		await vi.advanceTimersByTimeAsync(0)
		expect(abortCommit).toHaveBeenCalledTimes(1)
		expect(abortable.pending).toBeNull()

		let releaseFirst: () => void = () => {}
		const firstInFlight = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const inFlightCommit = vi.fn(() => firstInFlight)
		const nextUndo = vi.fn()
		await undoable.start({
			message: 'Disconnected first in-flight.',
			onCommit: inFlightCommit,
		})
		void undoable.commit()
		await Promise.resolve()
		expect(inFlightCommit).toHaveBeenCalledTimes(1)
		await undoable.start({
			message: 'Disconnected next.',
			onCommit: vi.fn(),
			onUndo: nextUndo,
		})
		await undoable.undo()
		expect(nextUndo).toHaveBeenCalledTimes(1)
		releaseFirst()
	} finally {
		vi.useRealTimers()
	}
})
