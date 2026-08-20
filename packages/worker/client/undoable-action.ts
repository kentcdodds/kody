import { type Handle } from 'remix/ui'

const defaultUndoTimeoutMs = 8_000

export type UndoableActionPending = {
	message: string
	undoLabel: string
}

export type UndoableActionStartInput = {
	message: string
	undoLabel?: string
	onCommit: () => void | Promise<void>
	onUndo?: () => void | Promise<void>
}

/**
 * Delayed-commit undo for destructive UI actions.
 *
 * After the caller confirms (typically via `createDoubleCheck`), apply the
 * optimistic result and call `start({ message, onCommit, onUndo })`. Undo
 * before `timeoutMs` runs `onUndo` and never `onCommit`. Otherwise `onCommit`
 * is the real mutation. Unmount and `pagehide` also commit so the action is
 * not lost if the user leaves. A second `start` commits the first pending
 * action first.
 *
 * `onCommit` should use `keepalive: true` on `fetch` when the mutation must
 * finish after navigation. Do not navigate to a remounting route during the
 * undo window; remount commits immediately and can restore optimistic UI.
 */
export function createUndoableAction(
	handle: Handle,
	options?: { timeoutMs?: number },
) {
	const timeoutMs = options?.timeoutMs ?? defaultUndoTimeoutMs
	let pending: UndoableActionPending | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let commitFn: (() => void | Promise<void>) | null = null
	let undoFn: (() => void | Promise<void>) | null = null

	function clearTimer() {
		if (timer === null) return
		clearTimeout(timer)
		timer = null
	}

	function clearPending() {
		pending = null
		commitFn = null
		undoFn = null
	}

	async function commit(options?: { silent?: boolean }) {
		if (!pending) return
		clearTimer()
		const fn = commitFn
		clearPending()
		if (!options?.silent) handle.update()
		await fn?.()
	}

	async function undo() {
		if (!pending) return
		clearTimer()
		const fn = undoFn
		clearPending()
		handle.update()
		await fn?.()
	}

	async function start(input: UndoableActionStartInput) {
		if (pending) await commit()
		pending = {
			message: input.message,
			undoLabel: input.undoLabel ?? 'Undo',
		}
		commitFn = input.onCommit
		undoFn = input.onUndo ?? null
		timer = setTimeout(() => {
			void commit()
		}, timeoutMs)
		handle.update()
	}

	const onPageHide = () => {
		void commit({ silent: true })
	}
	if (typeof document !== 'undefined') {
		window.addEventListener('pagehide', onPageHide)
	}
	handle.signal.addEventListener('abort', () => {
		if (typeof document !== 'undefined') {
			window.removeEventListener('pagehide', onPageHide)
		}
		void commit({ silent: true })
	})

	return {
		get pending() {
			return pending
		},
		start,
		undo,
		commit,
	}
}
