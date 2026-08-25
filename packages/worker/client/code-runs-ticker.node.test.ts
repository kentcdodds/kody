import { expect, test, vi } from 'vitest'
import { CodeRunsTicker } from '#client/code-runs-ticker.tsx'
import { type PublicCodeRunsWindow } from '#universal/code-runs.ts'

test('CodeRunsTicker defers scheduleNext through queueTask so setup never calls handle.update synchronously', () => {
	const previousDocument = globalThis.document
	const previousWindow = globalThis.window
	const previousMatchMedia = globalThis.matchMedia
	const previousRequestAnimationFrame = globalThis.requestAnimationFrame
	const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
	const previousPerformance = globalThis.performance
	const previousSetTimeout = globalThis.setTimeout
	const previousClearTimeout = globalThis.clearTimeout

	const addEventListener = vi.fn()
	globalThis.document = {
		visibilityState: 'visible',
		addEventListener,
	} as unknown as Document
	globalThis.window = {
		addEventListener,
	} as unknown as Window & typeof globalThis
	globalThis.matchMedia = vi.fn(() => ({
		matches: false,
	})) as unknown as typeof matchMedia
	globalThis.requestAnimationFrame = vi.fn(
		() => 1,
	) as typeof requestAnimationFrame
	globalThis.cancelAnimationFrame = vi.fn() as typeof cancelAnimationFrame
	globalThis.performance = { now: () => 0 } as Performance
	globalThis.setTimeout = vi.fn(() => 1) as unknown as typeof setTimeout
	globalThis.clearTimeout = vi.fn() as unknown as typeof clearTimeout

	const updateAt = new Date(Date.now() + 60_000).toISOString()
	const codeRunsWindow: PublicCodeRunsWindow = {
		start: 100,
		end: 200,
		updateAt,
	}

	let queuedTask: ((signal?: AbortSignal) => unknown) | undefined
	const update = vi.fn()
	const abort = new AbortController()

	try {
		CodeRunsTicker({
			props: { window: codeRunsWindow },
			signal: abort.signal,
			queueTask(task) {
				queuedTask = task
			},
			update,
		} as never)

		expect(queuedTask).toBeTypeOf('function')
		expect(update).not.toHaveBeenCalled()
		expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled()
		expect(globalThis.setTimeout).not.toHaveBeenCalled()

		queuedTask?.(abort.signal)

		expect(globalThis.requestAnimationFrame).toHaveBeenCalled()
	} finally {
		abort.abort()
		globalThis.document = previousDocument
		globalThis.window = previousWindow
		globalThis.matchMedia = previousMatchMedia
		globalThis.requestAnimationFrame = previousRequestAnimationFrame
		globalThis.cancelAnimationFrame = previousCancelAnimationFrame
		globalThis.performance = previousPerformance
		globalThis.setTimeout = previousSetTimeout
		globalThis.clearTimeout = previousClearTimeout
	}
})
