/**
 * Remix's reconcile runtime calls `Promise.withResolvers()` during client-side
 * frame resolution. This API was introduced in Safari 17 / iOS 17 (2023) and
 * is absent on older browsers (e.g. Mobile Safari 11 on iOS 11), which aborts
 * client hydration. Install a spec-compliant polyfill before `run()` when needed.
 *
 * `Promise.withResolvers` is ES2024 and not in the project's ES2022 lib, so we
 * access it via a cast to avoid TypeScript errors.
 */

type PromiseWithResolvers<T> = {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
}

type PromiseConstructorWithResolvers = typeof Promise & {
	withResolvers<T>(): PromiseWithResolvers<T>
}

export function ensurePromiseWithResolvers(): void {
	const P = Promise as PromiseConstructorWithResolvers
	if (typeof P.withResolvers === 'function') return

	const polyfill = function withResolvers<T>(
		this: typeof Promise,
	): PromiseWithResolvers<T> {
		let resolve!: (value: T | PromiseLike<T>) => void
		let reject!: (reason?: unknown) => void
		const promise = new this<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}

	try {
		Object.defineProperty(P, 'withResolvers', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: polyfill,
		})
	} catch {
		try {
			P.withResolvers = polyfill
		} catch {
			// Leave Promise unchanged; Remix will still throw if it calls withResolvers.
		}
	}
}
