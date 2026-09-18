/**
 * Remix UI's frame + reconcile runtime calls `Promise.withResolvers()`.
 * That is ES2024; mid-tier browsers omit it and abort hydration with
 * `TypeError: Promise.withResolvers is not a function`. Install the
 * standard `{ promise, resolve, reject }` polyfill before `run()` when
 * needed.
 *
 * This is not a Safari 11 / iOS 11 support program (KODY-7P). Those
 * engines lack far more than `withResolvers`; this only covers the Remix
 * gap on otherwise-capable browsers.
 */
type PromiseWithResolversResult<T> = {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
}

type PromiseWithResolversHost = {
	new <T>(
		executor: (
			resolve: (value: T | PromiseLike<T>) => void,
			reject: (reason?: unknown) => void,
		) => void,
	): Promise<T>
	withResolvers?: <T>() => PromiseWithResolversResult<T>
}

export function ensurePromiseWithResolvers(
	promiseCtor: PromiseWithResolversHost | undefined = Promise,
): void {
	if (!promiseCtor) return
	if (typeof promiseCtor.withResolvers === 'function') return

	const polyfill = function withResolvers<T>(
		this: PromiseWithResolversHost,
	): PromiseWithResolversResult<T> {
		let resolve!: (value: T | PromiseLike<T>) => void
		let reject!: (reason?: unknown) => void
		const promise = new this<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}

	try {
		Object.defineProperty(promiseCtor, 'withResolvers', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: polyfill,
		})
	} catch {
		try {
			promiseCtor.withResolvers = polyfill
		} catch {
			// Leave Promise unchanged; Remix will still throw if it calls withResolvers.
		}
	}
}
