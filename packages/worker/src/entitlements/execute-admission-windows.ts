export type ExecuteRepeatAdmission =
	| { admitted: true; repeats: number }
	| { admitted: false; repeats: number; retryAfterMs: number }

/**
 * Rolling-window count of identical execute calls per repeat key. Only
 * admitted calls are recorded, so a looping agent that keeps retrying gets
 * at most `limit` calls through per window. Held in memory and bounded to
 * `maxKeys` keys (least recently admitted evicted first): it is a loop
 * brake, not a billed counter, so forgetting a key only ever admits more.
 */
export class ExecuteRepeatWindow {
	readonly #startsByKey = new Map<string, Array<number>>()
	readonly #maxKeys: number

	constructor(maxKeys = 1_000) {
		this.#maxKeys = maxKeys
	}

	admit(input: {
		key: string
		nowMs: number
		limit: number
		windowMs: number
	}): ExecuteRepeatAdmission {
		const cutoff = input.nowMs - input.windowMs
		const starts = (this.#startsByKey.get(input.key) ?? []).filter(
			(startMs) => startMs > cutoff,
		)
		if (starts.length >= input.limit) {
			// Updating an existing key keeps its Map position, so a refused
			// retry does not count as recent use for eviction.
			this.#startsByKey.set(input.key, starts)
			const oldestBlocking = starts[starts.length - input.limit]!
			return {
				admitted: false,
				repeats: starts.length,
				retryAfterMs: Math.max(
					1,
					oldestBlocking + input.windowMs - input.nowMs,
				),
			}
		}
		starts.push(input.nowMs)
		this.#startsByKey.delete(input.key)
		this.#startsByKey.set(input.key, starts)
		if (this.#startsByKey.size > this.#maxKeys) {
			const leastRecent = this.#startsByKey.keys().next().value
			if (leastRecent !== undefined) this.#startsByKey.delete(leastRecent)
		}
		return { admitted: true, repeats: starts.length }
	}
}

export type ExecuteRepeatInput = {
	key: string
	limit: number
	windowMs: number
}

export type ExecuteAdmissionResult =
	| { admitted: true; count: number }
	| { admitted: false; reason: 'rate'; count: number; retryAfterMs: number }
	| { admitted: false; reason: 'repeat'; repeats: number; retryAfterMs: number }

export type ExecuteCallMinuteWindow = { minute: number; count: number }

/**
 * Per-minute rate check, then the identical-call check. A call refused by
 * either is not counted in the per-minute window.
 */
export function admitExecuteCallInWindows(input: {
	nowMs: number
	limitPerMinute: number
	repeat?: ExecuteRepeatInput
	minuteWindow: ExecuteCallMinuteWindow
	repeatWindow: ExecuteRepeatWindow
}): ExecuteAdmissionResult {
	const minute = Math.floor(input.nowMs / 60_000)
	const window = input.minuteWindow
	if (window.minute !== minute) {
		window.minute = minute
		window.count = 0
	}
	if (window.count >= input.limitPerMinute) {
		return {
			admitted: false,
			reason: 'rate',
			count: window.count,
			retryAfterMs: (minute + 1) * 60_000 - input.nowMs,
		}
	}
	if (input.repeat) {
		const repeat = input.repeatWindow.admit({
			key: input.repeat.key,
			nowMs: input.nowMs,
			limit: input.repeat.limit,
			windowMs: input.repeat.windowMs,
		})
		if (!repeat.admitted) {
			return {
				admitted: false,
				reason: 'repeat',
				repeats: repeat.repeats,
				retryAfterMs: repeat.retryAfterMs,
			}
		}
	}
	window.count += 1
	return { admitted: true, count: window.count }
}
