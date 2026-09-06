import {
	recordUsage,
	type UsageEnv,
	type UsageOutcome,
} from './record-usage.ts'

export const durableObjectGbSecondsEventType = 'durable_object_gb_seconds'

/**
 * Wrap a per-user Durable Object RPC stub so each method call records one
 * observe-only `durable_object_gb_seconds` event. `durationMs` is RPC
 * wall-clock; admin display converts that to GB-s at the default 128 MB.
 * Recording failures never surface to the caller. Without
 * `USAGE_EVENTS` the stub is returned unchanged so local/test
 * mocks that lack Analytics Engine do not attempt a D1 rollup.
 */
export function createMeteredDurableObjectStub<T extends object>(input: {
	env: UsageEnv
	userId: string
	doClass: string
	stub: T
}): T {
	if (!input.env.USAGE_EVENTS) return input.stub
	return new Proxy(input.stub, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver)
			if (typeof value !== 'function') return value
			return (...args: Array<unknown>) => {
				const startedAt = Date.now()
				let outcome: UsageOutcome = 'success'
				const finish = () => {
					void recordUsage(input.env, {
						userId: input.userId,
						eventType: durableObjectGbSecondsEventType,
						entityId: input.doClass,
						durationMs: Date.now() - startedAt,
						outcome,
					})
				}
				try {
					const result = value.apply(target, args) as unknown
					if (result && typeof result === 'object' && 'then' in result) {
						return Promise.resolve(result).then(
							(resolved) => {
								finish()
								return resolved
							},
							(error: unknown) => {
								outcome = 'error'
								finish()
								throw error
							},
						)
					}
					finish()
					return result
				} catch (error) {
					outcome = 'error'
					finish()
					throw error
				}
			}
		},
	})
}
