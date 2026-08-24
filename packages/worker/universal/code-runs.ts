/**
 * Public homepage “code runs” ticker: a 24-hour delayed replay of fleet
 * `execute` event counts. Interpolation is deterministic from the window so
 * every visitor at a given clock time sees the same integer. Each displayed
 * step is +1. When the pair has at least one tick per 3-second honesty
 * slot, a backbone tick lands every slot at a hashed phase so the cadence
 * does not march on the clock. Extra count still warps into busy seconds
 * and rolls through those seconds without skipping, with hashed gaps so a
 * busy second does not march. The count stays monotonic between `previous`
 * and `current`. A frozen client snaps to the official integer instead of
 * replaying missed steps. When leftover budget cannot support a 3-second
 * integer backbone, the client moves honest progress toward the next tick
 * instead of inventing +1s. Homepage GET may continue an expired or still
 * pair in memory when the fleet total has grown, or reset one to a new
 * still window when the fleet total has dropped; it does not write KV.
 * A client that cannot paint a next tick refetches `/code-runs.json`
 * instead of giving up for the rest of the tab.
 */

export const publicCodeRunsWindowMs = 24 * 60 * 60 * 1000
export const codeRunsHonestySlotMs = 3000

export type PublicCodeRunsWindow = {
	previous: number
	current: number
	windowStart: string
	windowEnd: string
}

export function isStillPublicCodeRunsWindow(window: PublicCodeRunsWindow) {
	return window.previous === window.current
}

export function stillPublicCodeRunsWindow(
	total: number,
	now: Date,
): PublicCodeRunsWindow {
	const nowMs = now.getTime()
	return {
		previous: total,
		current: total,
		windowStart: now.toISOString(),
		windowEnd: new Date(nowMs + publicCodeRunsWindowMs).toISOString(),
	}
}

export function publicCodeRunsWindowsEqual(
	left: PublicCodeRunsWindow,
	right: PublicCodeRunsWindow,
) {
	return (
		left.previous === right.previous &&
		left.current === right.current &&
		left.windowStart === right.windowStart &&
		left.windowEnd === right.windowEnd
	)
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
	const bounds = windowBounds(window)
	if (!bounds) return Math.max(window.current, window.previous)
	if (nowMs <= bounds.startMs) return bounds.previous
	if (nowMs >= bounds.endMs) return bounds.current
	if (bounds.delta === 0) return bounds.previous
	const ticks = ticksAfterElapsed({
		elapsedMs: nowMs - bounds.startMs,
		totalMs: bounds.totalMs,
		delta: bounds.delta,
		seed: bounds.seed,
	})
	if (ticks >= bounds.delta) return bounds.current - 1
	return bounds.previous + ticks
}

export function msUntilNextCodeRunsCount(
	window: PublicCodeRunsWindow,
	nowMs: number,
): number | null {
	const bounds = windowBounds(window)
	if (!bounds || bounds.delta === 0) return null
	if (nowMs >= bounds.endMs) return null
	const here = interpolateCodeRunsCount(window, nowMs)
	if (interpolateCodeRunsCount(window, bounds.endMs) <= here) return null
	let lo = nowMs + 1
	let hi = bounds.endMs
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2)
		if (interpolateCodeRunsCount(window, mid) > here) hi = mid
		else lo = mid + 1
	}
	return lo - nowMs
}

/**
 * Honest 0–1 progress from the last integer to the next. Zero when there is
 * no next tick (still pair, window ended, or already at current).
 */
export function codeRunsProgressToNext(
	window: PublicCodeRunsWindow,
	nowMs: number,
): number {
	const wait = msUntilNextCodeRunsCount(window, nowMs)
	if (wait == null || wait <= 0) return 0
	const bounds = windowBounds(window)
	if (!bounds || nowMs <= bounds.startMs) return 0
	const here = interpolateCodeRunsCount(window, nowMs)
	let lo = bounds.startMs
	let hi = nowMs
	while (lo < hi) {
		const mid = lo + Math.floor((hi - lo) / 2)
		if (interpolateCodeRunsCount(window, mid) < here) lo = mid + 1
		else hi = mid
	}
	const gap = nowMs - lo + wait
	if (gap <= 0) return 0
	return Math.min(1, (nowMs - lo) / gap)
}

/**
 * When to repaint so something honest moves at least every honesty slot.
 * Integer cadence wins when the next +1 is sooner than that.
 */
export function msUntilNextCodeRunsPaint(
	window: PublicCodeRunsWindow,
	nowMs: number,
): number | null {
	const wait = msUntilNextCodeRunsCount(window, nowMs)
	if (wait == null) return null
	return Math.min(wait, codeRunsHonestySlotMs)
}

/**
 * In-memory continuation when KV still holds a pair that cannot tick.
 * Grows a still / expired pair when the fleet total is higher. Resets to a
 * new still window when the fleet total dropped (a latched high-water mark
 * would otherwise freeze the ticker). Null means keep `stored`.
 */
export function continuePublicCodeRunsWindow(input: {
	stored: PublicCodeRunsWindow
	total: number
	now: Date
}): PublicCodeRunsWindow | null {
	if (input.total <= 0) return null
	const nowMs = input.now.getTime()
	const endMs = Date.parse(input.stored.windowEnd)
	const expired = Number.isFinite(endMs) && nowMs >= endMs
	const still = isStillPublicCodeRunsWindow(input.stored)
	if (!expired && !still) return null
	if (input.total < input.stored.current) {
		return stillPublicCodeRunsWindow(input.total, input.now)
	}
	if (input.total === input.stored.current) return null
	if (still && !expired) {
		return {
			previous: input.stored.current,
			current: input.total,
			windowStart: input.now.toISOString(),
			windowEnd: new Date(nowMs + publicCodeRunsWindowMs).toISOString(),
		}
	}
	const startMs = Number.isFinite(endMs) ? endMs : nowMs
	return {
		previous: input.stored.current,
		current: input.total,
		windowStart: new Date(startMs).toISOString(),
		windowEnd: new Date(startMs + publicCodeRunsWindowMs).toISOString(),
	}
}

export const codeRunsCatchUpSnapAfterMs = 1000
export const codeRunsCatchUpSnapBehind = 60

/**
 * Advance the on-screen ticker by one integer while the tab is live.
 * After a freeze (or when more than sixty integers are already owed),
 * jump to the official count instead of replaying the missed steps.
 */
export function nextDisplayedCodeRunsCount(input: {
	displayed: number
	official: number
	elapsedMsSinceDisplay: number
}): number {
	if (input.official <= input.displayed) return input.displayed
	const behind = input.official - input.displayed
	if (
		input.elapsedMsSinceDisplay > codeRunsCatchUpSnapAfterMs ||
		behind > codeRunsCatchUpSnapBehind
	) {
		return input.official
	}
	return input.displayed + 1
}

/**
 * Delay before the next live leftover +1. Uses the owed count from
 * before the step so a single remaining integer cannot wait a full
 * second and trip the freeze snap.
 */
export function codeRunsCatchUpDelayMs(behindBeforeStep: number): number {
	if (behindBeforeStep <= 1) return 16
	return Math.max(16, Math.floor(1000 / behindBeforeStep))
}

const coarseSegmentCount = 72
const fineSegmentCount = 8

type WindowBounds = {
	previous: number
	current: number
	delta: number
	startMs: number
	endMs: number
	totalMs: number
	seed: number
}

function windowBounds(window: PublicCodeRunsWindow): WindowBounds | null {
	const previous = window.previous
	const current = Math.max(window.current, previous)
	const startMs = Date.parse(window.windowStart)
	const endMs = Date.parse(window.windowEnd)
	if (
		!Number.isFinite(startMs) ||
		!Number.isFinite(endMs) ||
		endMs <= startMs
	) {
		return null
	}
	return {
		previous,
		current,
		delta: current - previous,
		startMs,
		endMs,
		totalMs: endMs - startMs,
		seed: windowSeed(window),
	}
}

function ticksAfterElapsed(input: {
	elapsedMs: number
	totalMs: number
	delta: number
	seed: number
}): number {
	const totalSeconds = Math.floor(input.totalMs / 1000)
	if (totalSeconds <= 0) {
		return Math.floor(input.delta * (input.elapsedMs / input.totalMs))
	}
	const slots = Math.floor(input.totalMs / codeRunsHonestySlotMs)
	const useBackbone = input.delta >= slots && slots > 0
	const extra = useBackbone ? input.delta - slots : input.delta
	const secondIndex = Math.min(
		Math.floor(input.elapsedMs / 1000),
		totalSeconds - 1,
	)
	const fracMs = input.elapsedMs - secondIndex * 1000
	const extrasBefore = extraBeforeSecond(
		secondIndex,
		extra,
		totalSeconds,
		input.seed,
	)
	const extrasAfter = extraBeforeSecond(
		secondIndex + 1,
		extra,
		totalSeconds,
		input.seed,
	)
	const extrasFired = ticksFiredInSecond(
		extrasAfter - extrasBefore,
		fracMs,
		input.seed,
		secondIndex,
	)
	const backbone = useBackbone
		? backboneTicksAfterElapsed(input.elapsedMs, slots, input.seed)
		: 0
	return extrasBefore + extrasFired + backbone
}

function backboneTicksAfterElapsed(
	elapsedMs: number,
	slots: number,
	seed: number,
): number {
	const phase = Math.floor(hashUnit(seed, 11) * codeRunsHonestySlotMs)
	if (elapsedMs < phase) return 0
	return Math.min(
		slots,
		1 + Math.floor((elapsedMs - phase) / codeRunsHonestySlotMs),
	)
}

function extraBeforeSecond(
	secondIndex: number,
	extra: number,
	totalSeconds: number,
	seed: number,
): number {
	if (extra <= 0 || secondIndex <= 0) return 0
	if (secondIndex >= totalSeconds) return extra
	return Math.floor(
		extra * warpCodeRunsProgress(secondIndex / totalSeconds, seed),
	)
}

function ticksFiredInSecond(
	gain: number,
	fracMs: number,
	seed: number,
	secondIndex: number,
): number {
	if (gain <= 0) return 0
	if (gain === 1) {
		return fracMs >= singleTickFireMs(seed, secondIndex) ? 1 : 0
	}
	const fires = busySecondFireMs(gain, seed, secondIndex)
	let fired = 0
	for (const fireAt of fires) {
		if (fracMs < fireAt) break
		fired += 1
	}
	return fired
}

function busySecondFireMs(
	gain: number,
	seed: number,
	secondIndex: number,
): Array<number> {
	const unique = Math.min(gain, 1000)
	const minGap =
		unique <= 1 ? 1 : Math.max(1, Math.min(16, Math.floor(999 / (unique - 1))))
	const weights = Array.from({ length: unique }, (_, index) =>
		busySecondGapWeight(seed, secondIndex, index),
	)
	let total = 0
	for (const weight of weights) total += weight
	const maxLead = Math.min(180, Math.max(0, 999 - (unique - 1) * minGap))
	const lead = Math.floor(hashUnit(seed, secondIndex + 41) * (maxLead + 1))
	const span = Math.max(0, 999 - lead)
	const fires = Array.from({ length: unique }, () => 0)
	let prefix = 0
	for (let index = 0; index < unique; index += 1) {
		const desired = lead + Math.floor((prefix / total) * span)
		const earliest = index === 0 ? 0 : (fires[index - 1] ?? 0) + minGap
		const latest = 999 - (unique - 1 - index) * minGap
		fires[index] = Math.min(latest, Math.max(earliest, desired))
		prefix += weights[index] ?? 0
	}
	// More than 1000 ticks cannot get unique milliseconds; extras share 999
	// and a visible client rolls through them. A tab that froze snaps.
	while (fires.length < gain) fires.push(999)
	return fires
}

function busySecondGapWeight(
	seed: number,
	secondIndex: number,
	index: number,
): number {
	const unit = hashUnit(seed, Math.imul(secondIndex + 1, 31) + index + 19)
	return 0.2 + unit * unit * 2.3
}

function singleTickFireMs(seed: number, secondIndex: number): number {
	return Math.floor(hashUnit(seed, secondIndex + 11) * 1000)
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
	return 0.75 + unit * 0.5
}

function fineWeight(seed: number, coarseIndex: number, index: number): number {
	const unit = hashUnit(seed, Math.imul(coarseIndex + 1, 17) + index + 3)
	return 0.65 + unit * 0.7
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
