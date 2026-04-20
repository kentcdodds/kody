export type ToolTiming = {
	startedAt: string
	endedAt: string
	durationMs: number
}

type ToolTimingStart = {
	startedAt: string
	startedAtMs: number
}

export function startToolTiming(): ToolTimingStart {
	return {
		startedAt: new Date().toISOString(),
		startedAtMs: performance.now(),
	}
}

export function finishToolTiming(start: ToolTimingStart): ToolTiming {
	const durationMs = Math.max(
		0,
		Math.round(performance.now() - start.startedAtMs),
	)
	return {
		startedAt: start.startedAt,
		endedAt: new Date(Date.parse(start.startedAt) + durationMs).toISOString(),
		durationMs,
	}
}
