import { AsyncLocalStorage } from 'node:async_hooks'

type DeferredWorkSink = (promise: Promise<unknown>) => void

// AsyncLocalStorage rather than a per-request argument: the app router is
// cached per isolate and closes over `env` only, so route handlers have no
// path to the per-invocation `ExecutionContext`. The store propagates through
// the awaits between `handleRequest` and a handler.
const deferredWorkStorage = new AsyncLocalStorage<DeferredWorkSink>()

export function runWithDeferredWork<Result>(
	sink: DeferredWorkSink | undefined,
	run: () => Result,
): Result {
	if (!sink) return run()
	return deferredWorkStorage.run(sink, run)
}

/**
 * Run `work` without holding up the response, keeping it alive past the
 * response with `ctx.waitUntil` when a sink is registered for this request.
 * Failures are logged under `errorLabel` and never surface to the caller.
 */
export function deferWork(
	errorLabel: string,
	work: () => Promise<unknown>,
): Promise<void> {
	const promise = (async () => {
		try {
			await work()
		} catch (error) {
			console.warn(errorLabel, error)
		}
	})()
	deferredWorkStorage.getStore()?.(promise)
	return promise
}
