import { expect, test, vi } from 'vitest'
import {
	createViewTransitionScheduler,
	type ViewTransitionLike,
	type ViewTransitionStarter,
} from './view-transition-scheduler.ts'

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function fakeTransition(input: {
	updateCallbackDone: Promise<void>
}): ViewTransitionLike {
	const ready = deferred<void>()
	const finished = deferred<void>()
	return {
		updateCallbackDone: input.updateCallbackDone,
		ready: ready.promise,
		finished: finished.promise,
		skipTransition() {
			ready.reject(new DOMException('skipped', 'AbortError'))
			finished.reject(
				new DOMException(
					'Transition was aborted because of invalid state',
					'InvalidStateError',
				),
			)
		},
	}
}

async function waitFor(predicate: () => boolean, label: string, maxTurns = 20) {
	for (let turn = 0; turn < maxTurns; turn++) {
		if (predicate()) return
		await Promise.resolve()
	}
	throw new Error(`timed out waiting for ${label}`)
}

test('view transition scheduler waits for the prior update callback before starting the next transition', async () => {
	const firstCallback = deferred<void>()
	const starts: Array<string> = []
	const starter = vi.fn<ViewTransitionStarter>((callback) => {
		const id = starts.length === 0 ? 'first' : 'second'
		starts.push(id)
		return fakeTransition({ updateCallbackDone: callback() })
	})

	const scheduler = createViewTransitionScheduler(() => starter)

	scheduler.run(async () => {
		await firstCallback.promise
	})
	await waitFor(() => starts.length === 1, 'first start')

	scheduler.run(async () => {
		// second swap
	})

	// Second start must not run until the first update callback settles.
	expect(starts).toEqual(['first'])
	expect(starter).toHaveBeenCalledTimes(1)

	firstCallback.resolve()
	await scheduler.whenIdle()

	expect(starts).toEqual(['first', 'second'])
	expect(starter).toHaveBeenCalledTimes(2)
})

test('view transition scheduler keeps only the latest pending swap under rapid superseding navigations', async () => {
	const firstCallback = deferred<void>()
	const swaps: Array<string> = []
	const starter = vi.fn<ViewTransitionStarter>((callback) =>
		fakeTransition({ updateCallbackDone: callback() }),
	)

	const scheduler = createViewTransitionScheduler(() => starter)
	scheduler.run(async () => {
		swaps.push('a')
		await firstCallback.promise
	})
	await waitFor(() => swaps.includes('a'), 'swap a')

	scheduler.run(async () => {
		swaps.push('b')
	})
	scheduler.run(async () => {
		swaps.push('c')
	})

	firstCallback.resolve()
	await scheduler.whenIdle()

	// 'a' ran as the in-flight transition; 'b' was superseded by 'c'.
	expect(swaps).toEqual(['a', 'c'])
	expect(starter).toHaveBeenCalledTimes(2)
})

test('view transition scheduler falls back to an instant swap when startViewTransition throws', async () => {
	const swaps: Array<string> = []
	const starter = vi.fn<ViewTransitionStarter>(() => {
		throw new DOMException(
			'Transition was aborted because of invalid state',
			'InvalidStateError',
		)
	})

	const scheduler = createViewTransitionScheduler(() => starter)
	scheduler.run(async () => {
		swaps.push('fallback')
	})
	await scheduler.whenIdle()

	expect(swaps).toEqual(['fallback'])
})

test('view transition scheduler skips the API when startViewTransition is unavailable', async () => {
	const swaps: Array<string> = []
	const scheduler = createViewTransitionScheduler(() => null)
	scheduler.run(async () => {
		swaps.push('instant')
	})
	await Promise.resolve()
	expect(swaps).toEqual(['instant'])
})

test('cancelPending drops queued swaps so an instant navigation cannot be followed by a stale VT', async () => {
	const firstCallback = deferred<void>()
	const swaps: Array<string> = []
	const starter = vi.fn<ViewTransitionStarter>((callback) =>
		fakeTransition({ updateCallbackDone: callback() }),
	)

	const scheduler = createViewTransitionScheduler(() => starter)
	scheduler.run(async () => {
		swaps.push('a')
		await firstCallback.promise
	})
	await waitFor(() => swaps.includes('a'), 'swap a')

	scheduler.run(async () => {
		swaps.push('b-queued')
	})
	scheduler.cancelPending()
	firstCallback.resolve()
	await scheduler.whenIdle()

	expect(swaps).toEqual(['a'])
	expect(starter).toHaveBeenCalledTimes(1)
})

test('skipped transition lifecycle rejections are swallowed (no unhandledrejection)', async () => {
	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)

	try {
		const firstCallback = deferred<void>()
		const starter = vi.fn<ViewTransitionStarter>((callback) =>
			fakeTransition({ updateCallbackDone: callback() }),
		)
		const scheduler = createViewTransitionScheduler(() => starter)

		scheduler.run(async () => {
			await firstCallback.promise
		})
		await waitFor(() => starter.mock.calls.length === 1, 'first start')
		// Supersede: skipTransition rejects ready/finished.
		scheduler.run(async () => {})
		firstCallback.resolve()
		await scheduler.whenIdle()
		// Give the event loop a turn to surface any unhandled rejections.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})
