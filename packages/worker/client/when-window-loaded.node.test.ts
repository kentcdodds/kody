import { expect, test, vi } from 'vitest'
import { whenWindowLoaded } from './when-window-loaded.ts'

test('whenWindowLoaded runs now if the document is already complete, otherwise waits for load', () => {
	const onLoad = vi.fn()
	vi.stubGlobal('document', { readyState: 'complete' })
	const stopComplete = whenWindowLoaded(onLoad)
	expect(onLoad).toHaveBeenCalledTimes(1)
	stopComplete()

	const listeners = new Map<string, () => void>()
	const addEventListener = vi.fn((type: string, listener: () => void) => {
		listeners.set(type, listener)
	})
	const removeEventListener = vi.fn()
	vi.stubGlobal('document', { readyState: 'interactive' })
	vi.stubGlobal('window', { addEventListener, removeEventListener })

	const later = vi.fn()
	const stop = whenWindowLoaded(later)
	expect(later).not.toHaveBeenCalled()
	expect(addEventListener).toHaveBeenCalledWith('load', later, { once: true })
	listeners.get('load')?.()
	expect(later).toHaveBeenCalledTimes(1)
	stop()
	expect(removeEventListener).toHaveBeenCalledWith('load', later)

	const aborted = vi.fn()
	const controller = new AbortController()
	controller.abort()
	whenWindowLoaded(aborted, controller.signal)
	expect(aborted).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
})
