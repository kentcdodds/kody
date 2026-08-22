/**
 * Public homepage “code runs” ticker: a 24-hour delayed replay of fleet
 * `execute` event counts. Interpolation is deterministic from the window
 * so every visitor at a given second sees the same number. Ticks land at
 * least every three seconds when the pair has enough count, with hashed
 * leftover bursts so steps vary in size. The count stays monotonic between
 * `previous` and `current`.
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
	const secondMs = Math.floor(nowMs / 1000) * 1000
	if (secondMs <= startMs) return previous
	if (secondMs >= endMs) return current
	const delta = current - previous
	if (delta === 0) return previous
	return (
		previous +
		ticksAfterElapsed({
			elapsedMs: secondMs - startMs,
			totalMs: endMs - startMs,
			delta,
			seed: windowSeed(window),
		})
	)
}

const maxIdleSeconds = 3
const secondsPerCell = maxIdleSeconds
const cellMs = maxIdleSeconds * 1000
const coarseSegmentCount = 72
const fineSegmentCount = 8

function ticksAfterElapsed(input: {
	elapsedMs: number
	totalMs: number
	delta: number
	seed: number
}): number {
	const totalCells = Math.floor(input.totalMs / cellMs)
	if (totalCells <= 0) {
		return Math.floor(input.delta * (input.elapsedMs / input.totalMs))
	}
	const rawCell = Math.floor(input.elapsedMs / cellMs)
	if (rawCell >= totalCells) return input.delta
	const useBackbone = input.delta >= totalCells
	const extra = useBackbone ? input.delta - totalCells : input.delta
	const before =
		extraBeforeCell(rawCell, extra, totalCells, input.seed) +
		(useBackbone ? rawCell : 0)
	const inCell =
		extraBeforeCell(rawCell + 1, extra, totalCells, input.seed) -
		extraBeforeCell(rawCell, extra, totalCells, input.seed) +
		(useBackbone ? 1 : 0)
	const offset = Math.min(
		Math.floor((input.elapsedMs % cellMs) / 1000),
		secondsPerCell - 1,
	)
	const split = splitCellTicks(inCell, input.seed, rawCell)
	let partial = 0
	for (let index = 0; index <= offset; index += 1) {
		partial += split[index] ?? 0
	}
	return before + partial
}

function extraBeforeCell(
	cellIndex: number,
	extra: number,
	totalCells: number,
	seed: number,
): number {
	if (extra <= 0 || cellIndex <= 0) return 0
	if (cellIndex >= totalCells) return extra
	return Math.floor(
		extra * warpCodeRunsProgress(cellIndex / totalCells, seed),
	)
}

function splitCellTicks(
	ticks: number,
	seed: number,
	cellIndex: number,
): Array<number> {
	const split = Array.from({ length: secondsPerCell }, () => 0)
	if (ticks <= 0) return split
	split[secondsPerCell - 1] = 1
	const leftover = ticks - 1
	if (leftover <= 0) return split
	let weightPrefix = 0
	let tickPrefix = 0
	let total = 0
	const weights = Array.from({ length: secondsPerCell }, (_, index) => {
		const weight = cellSecondWeight(seed, cellIndex, index)
		total += weight
		return weight
	})
	for (let index = 0; index < secondsPerCell; index += 1) {
		weightPrefix += weights[index] ?? 0
		const next =
			index === secondsPerCell - 1
				? leftover
				: Math.floor((weightPrefix / total) * leftover)
		split[index] = (split[index] ?? 0) + (next - tickPrefix)
		tickPrefix = next
	}
	return split
}

function cellSecondWeight(
	seed: number,
	cellIndex: number,
	index: number,
): number {
	const unit = hashUnit(seed, Math.imul(cellIndex + 1, 29) + index + 5)
	return 0.4 + unit * unit * 4
}

function windowSeed(window: PublicCodeRunsWindow): number {
	return hash32(
		hash32(Date.parse(window.windowStart)) ^
			hash32(window.previous) ^
			Math.imul(hash32(window.current), 3),
	)
}

function warpCodeRunsProgress(progress: number, seed: number): number {
	if (progress <= 0) return 0
	if (progress >= 1) return 1
	const position = progress * coarseSegmentCount
	const coarseIndex = Math.min(Math.floor(position), coarseSegmentCount - 1)
	const coarseFrac = position - coarseIndex
	let prefix = 0
	let total = 0
	for (let index = 0; index < coarseSegmentCount; index += 1) {
		const weight = coarseWeight(seed, index)
		total += weight
		if (index < coarseIndex) prefix += weight
	}
	const currentWeight = coarseWeight(seed, coarseIndex)
	const fine = warpFineProgress(coarseFrac, seed, coarseIndex)
	return (prefix + currentWeight * fine) / total
}

function warpFineProgress(
	frac: number,
	seed: number,
	coarseIndex: number,
): number {
	if (frac <= 0) return 0
	if (frac >= 1) return 1
	const position = frac * fineSegmentCount
	const fineIndex = Math.min(Math.floor(position), fineSegmentCount - 1)
	const inner = position - fineIndex
	let prefix = 0
	let total = 0
	for (let index = 0; index < fineSegmentCount; index += 1) {
		const weight = fineWeight(seed, coarseIndex, index)
		total += weight
		if (index < fineIndex) prefix += weight
	}
	return (prefix + fineWeight(seed, coarseIndex, fineIndex) * inner) / total
}

function coarseWeight(seed: number, index: number): number {
	const unit = hashUnit(seed, index + 1)
	return 0.03 + unit * unit * unit * 7
}

function fineWeight(seed: number, coarseIndex: number, index: number): number {
	const unit = hashUnit(seed, Math.imul(coarseIndex + 1, 17) + index + 3)
	return 0.2 + unit * unit * 3
}

function hashUnit(seed: number, salt: number): number {
	return hash32(seed ^ Math.imul(salt, 0x9e3779b9)) / 0x1_0000_0000
}

function hash32(value: number): number {
	let n = value | 0
	n = Math.imul(n ^ (n >>> 16), 0x7feb352d)
	n = Math.imul(n ^ (n >>> 15), 0x846ca68b)
	return (n ^ (n >>> 16)) >>> 0
}

export function formatCodeRunsCount(count: number): string {
	return new Intl.NumberFormat('en-US').format(count)
}

function readNonNegativeInt(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null
	if (value < 0) return null
	return Math.floor(value)
}
