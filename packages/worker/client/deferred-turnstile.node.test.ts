import { expect, test, vi } from 'vitest'
import { observeNearViewport } from '#client/deferred-turnstile.ts'

test('observeNearViewport arms immediately without IntersectionObserver and waits when present', () => {
	vi.stubGlobal('IntersectionObserver', undefined)
	const immediate = vi.fn()
	const stop = observeNearViewport({} as Element, immediate)
	expect(immediate).toHaveBeenCalledTimes(1)
	stop()
	vi.unstubAllGlobals()

	const observe = vi.fn()
	const disconnect = vi.fn()
	let callback: IntersectionObserverCallback = () => {}
	class FakeObserver {
		constructor(cb: IntersectionObserverCallback) {
			callback = cb
		}
		observe = observe
		disconnect = disconnect
	}
	vi.stubGlobal('IntersectionObserver', FakeObserver)

	const onNear = vi.fn()
	const element = {} as Element
	observeNearViewport(element, onNear, '200px')

	expect(observe).toHaveBeenCalledWith(element)
	expect(onNear).not.toHaveBeenCalled()

	callback(
		[{ isIntersecting: false } as IntersectionObserverEntry],
		{} as IntersectionObserver,
	)
	expect(onNear).not.toHaveBeenCalled()

	callback(
		[{ isIntersecting: true } as IntersectionObserverEntry],
		{} as IntersectionObserver,
	)
	expect(onNear).toHaveBeenCalledTimes(1)
	expect(disconnect).toHaveBeenCalledTimes(1)
	vi.unstubAllGlobals()
})
