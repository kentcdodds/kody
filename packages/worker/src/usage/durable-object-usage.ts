import { waitUntil } from 'cloudflare:workers'
import {
	recordUsage,
	type UsageEnv,
	type UsageOutcome,
} from './record-usage.ts'

export const durableObjectGbSecondsEventType = 'durable_object_gb_seconds'

/**
 * Wait after the last RPC in a burst before writing one Analytics Engine
 * point. Sequential StorageRunner calls in one request then share a single
 * `writeDataPoint` instead of competing with `package_static_call` and
 * `outbound_fetch` for the per-invocation budget.
 */
export const durableObjectUsageCoalesceDelayMs = 25

type PendingDurableObjectUsage = {
	env: UsageEnv
	userId: string
	doClass: string
	outcome: UsageOutcome
	durationMs: number
	eventCount: number
}

const pendingByKey = new Map<string, PendingDurableObjectUsage>()
let coalesceTimer: ReturnType<typeof setTimeout> | null = null
let flushWaitUntil: (() => void) | null = null
let inFlightFlush: Promise<void> | null = null

/**
 * Wrap a per-user Durable Object RPC stub so method calls record observe-only
 * `durable_object_gb_seconds` events. `durationMs` is RPC wall-clock; admin
 * display converts that to GB-s at the default 128 MB. Same-outcome RPCs in
 * one burst coalesce into a single write. Recording failures never surface
 * to the caller. Without `USAGE_EVENTS` the stub is returned unchanged so
 * local/test mocks that lack Analytics Engine do not attempt a D1 rollup.
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
					queueDurableObjectUsage({
						env: input.env,
						userId: input.userId,
						doClass: input.doClass,
						outcome,
						durationMs: Date.now() - startedAt,
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

/**
 * Flush queued Durable Object duration now. Tests call this instead of
 * waiting for the coalesce timer; production waitUntil uses the same path.
 */
export async function flushDurableObjectUsageWrites(): Promise<void> {
	if (coalesceTimer != null) {
		clearTimeout(coalesceTimer)
		coalesceTimer = null
	}
	const pending = flushWaitUntil
	flushWaitUntil = null
	try {
		await flushQueuedDurableObjectUsage()
	} finally {
		pending?.()
	}
}

function queueDurableObjectUsage(input: {
	env: UsageEnv
	userId: string
	doClass: string
	outcome: UsageOutcome
	durationMs: number
}) {
	const key = `${input.userId}\0${input.doClass}\0${input.outcome}`
	const existing = pendingByKey.get(key)
	if (existing) {
		existing.durationMs += input.durationMs
		existing.eventCount += 1
	} else {
		pendingByKey.set(key, {
			env: input.env,
			userId: input.userId,
			doClass: input.doClass,
			outcome: input.outcome,
			durationMs: input.durationMs,
			eventCount: 1,
		})
	}
	scheduleDurableObjectUsageFlush()
}

function scheduleDurableObjectUsageFlush() {
	if (coalesceTimer != null) {
		clearTimeout(coalesceTimer)
	}
	if (flushWaitUntil == null) {
		waitUntil(
			new Promise<void>((resolve) => {
				flushWaitUntil = resolve
			}),
		)
	}
	coalesceTimer = setTimeout(() => {
		coalesceTimer = null
		void flushDurableObjectUsageWrites()
	}, durableObjectUsageCoalesceDelayMs)
}

async function flushQueuedDurableObjectUsage() {
	if (inFlightFlush) {
		await inFlightFlush
		if (pendingByKey.size === 0) return
	}
	const buckets = [...pendingByKey.values()]
	pendingByKey.clear()
	if (buckets.length === 0) return
	const flush = Promise.all(
		buckets.map((bucket) =>
			recordUsage(bucket.env, {
				userId: bucket.userId,
				eventType: durableObjectGbSecondsEventType,
				entityId: bucket.doClass,
				durationMs: bucket.durationMs,
				eventCount: bucket.eventCount,
				outcome: bucket.outcome,
			}),
		),
	).then(() => undefined)
	inFlightFlush = flush
	try {
		await flush
	} finally {
		if (inFlightFlush === flush) inFlightFlush = null
	}
}
