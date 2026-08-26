/**
 * Geometry for the homepage hero hub-and-spoke: host chips on an upper arc,
 * Kody hub at the base. Percent coordinates match a square-ish orbit box
 * (viewBox 0 0 100 100 style math).
 */

export const heroOrbitHub = { x: 50, y: 86 } as const

/** Upper arc from near-left to near-right (radians). */
const orbitStartAngle = Math.PI * 0.92
const orbitEndAngle = Math.PI * 0.08
const orbitRadius = 38

export function heroOrbitPoint(index: number, total: number) {
	const t = total <= 1 ? 0.5 : index / (total - 1)
	const angle = orbitStartAngle - t * (orbitStartAngle - orbitEndAngle)
	return {
		x: heroOrbitHub.x + orbitRadius * Math.cos(angle),
		y: heroOrbitHub.y - 8 - orbitRadius * Math.sin(angle),
		angle,
	}
}

export function heroOrbitSpokePath(index: number, total: number) {
	const point = heroOrbitPoint(index, total)
	return {
		x1: heroOrbitHub.x,
		y1: heroOrbitHub.y - 6,
		x2: point.x,
		y2: point.y,
	}
}

/** Arc path through host points — walker rides this with CSS offset-path. */
export function heroOrbitArcPath(total: number) {
	if (total <= 0) return ''
	const points = Array.from({ length: total }, (_, index) =>
		heroOrbitPoint(index, total),
	)
	const [first, ...rest] = points
	if (!first) return ''
	let d = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`
	for (const point of rest) {
		d += ` L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
	}
	return d
}
