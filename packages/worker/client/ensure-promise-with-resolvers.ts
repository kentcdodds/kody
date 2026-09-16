/**
 * Remix's reconcile runtime calls `Promise.withResolvers()` during client-side
 * frame resolution. This API was introduced in Safari 17 / iOS 17 (2023) and
 * is absent on older browsers (e.g. Mobile Safari 11 on iOS 11), which aborts
 * client hydration. Install a spec-compliant polyfill before `run()` when needed.
 */
export function ensurePromiseWithResolvers(): void {
	if (typeof Promise.withResolvers === 'function') return

	const polyfill = function withResolvers<T>(
		this: typeof Promise,
	): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
		let resolve!: (value: T | PromiseLike<T>) => void
		let reject!: (reason?: unknown) => void
		const promise = new this<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}

	try {
		Object.defineProperty(Promise, 'withResolvers', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: polyfill,
		})
	} catch {
		try {
			// @ts-expect-error — fallback assignment when defineProperty is restricted
			Promise.withResolvers = polyfill
		} catch {
			// Leave Promise unchanged; Remix will still throw if it calls withResolvers.
		}
	}
}
