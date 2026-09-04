/** Slow walk of one lap around the real card set. */
export const TESTIMONIALS_LAP_MS = 45_000

export type LanePlacement = {
	itemIndex: number
	x: number
	/** Second (or later) copy of the same quote, used when it straddles the seam. */
	seam: boolean
}

export function wrapPagerIndex(index: number, count: number) {
	if (count <= 0) return 0
	return ((index % count) + count) % count
}

export function wrapUnitInterval(value: number, period: number) {
	if (period <= 0) return 0
	const next = value % period
	return next < 0 ? next + period : next
}

/**
 * Visible + overscan placements on a circular lane.
 *
 * One logical quote can emit two placements when it straddles the wrap
 * (left edge and right edge at once). That is the extra seam copy — not a
 * 3× clone of the whole set.
 */
export function listLanePlacements(input: {
	count: number
	stride: number
	cardWidth: number
	offset: number
	viewportWidth: number
	overscan?: number
}): Array<LanePlacement> {
	const { count, stride, cardWidth, offset, viewportWidth } = input
	const overscan = input.overscan ?? stride
	const totalWidth = count * stride
	if (count <= 0 || stride <= 0 || totalWidth <= 0) return []

	const viewLeft = -overscan
	const viewRight = viewportWidth + overscan
	const placements: Array<LanePlacement> = []

	for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
		const primary = wrapUnitInterval(itemIndex * stride - offset, totalWidth)
		const firstLap = Math.floor((viewLeft - cardWidth - primary) / totalWidth)
		const lastLap = Math.ceil((viewRight - primary) / totalWidth)
		let copies = 0
		for (let lap = firstLap; lap <= lastLap; lap += 1) {
			const x = primary + lap * totalWidth
			if (x >= viewRight || x + cardWidth <= viewLeft) continue
			placements.push({ itemIndex, x, seam: copies > 0 })
			copies += 1
		}
	}

	return placements
}
