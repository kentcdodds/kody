/**
 * Public homepage “code runs” ticker: a 24-hour delayed replay of fleet
 * `execute` event counts. Interpolation is deterministic from the window
 * timestamps so every visitor at a given second sees the same number.
 */

export const publicCodeRunsWindowMs = 24 * 60 * 60 * 1000

export type PublicCodeRunsWindow = {
	previous: number
	current: number
	windowStart: string
	windowEnd: string
}

export function parsePublicCodeRunsWindow(
	value: unknown,
): PublicCodeRunsWindow | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const previous = readNonNegativeInt(record.previous)
	const current = readNonNegativeInt(record.current)
	if (previous === null || current === null) return null
	if (typeof record.windowStart !== 'string') return null
	if (typeof record.windowEnd !== 'string') return null
	const startMs = Date.parse(record.windowStart)
	const endMs = Date.parse(record.windowEnd)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
	if (endMs - startMs !== publicCodeRunsWindowMs) return null
	return {
		previous,
		current: Math.max(current, previous),
		windowStart: record.windowStart,
		windowEnd: record.windowEnd,
	}
}

export function interpolateCodeRunsCount(
	window: PublicCodeRunsWindow,
	nowMs: number,
): number {
	const previous = window.previous
	const current = Math.max(window.current, previous)
	const startMs = Date.parse(window.windowStart)
	const endMs = Date.parse(window.windowEnd)
	if (
		!Number.isFinite(startMs) ||
		!Number.isFinite(endMs) ||
		endMs <= startMs
	) {
		return current
	}
	if (nowMs <= startMs) return previous
	if (nowMs >= endMs) return current
	const progress = (nowMs - startMs) / (endMs - startMs)
	return previous + Math.floor((current - previous) * progress)
}

export function formatCodeRunsCount(count: number): string {
	return new Intl.NumberFormat('en-US').format(count)
}

function readNonNegativeInt(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	if (value < 0) return null
	return Math.floor(value)
}
