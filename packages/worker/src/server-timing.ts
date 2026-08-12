export type ServerTimingEntry = {
	name: string
	durationMs: number
}

/**
 * Request-scoped Server-Timing style phase measurement. Same shape as execute
 * `serverTiming`: `{ name, durationMs }`, returned on the response, not stored.
 * `Date.now()` in Workers only advances across I/O, which is what we want for
 * attributing Artifacts/git round trips.
 */
export async function pushServerTiming<T>(
	timings: Array<ServerTimingEntry> | undefined,
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	if (!timings) return await run()
	const startedAt = Date.now()
	try {
		return await run()
	} finally {
		timings.push({ name, durationMs: Date.now() - startedAt })
	}
}
