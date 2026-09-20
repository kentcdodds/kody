import { type LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Five-orb lantern for the homepage primitives section. Orb centres are
 * percentages of the lantern still (`kody-primitives-lantern.webp`),
 * measured from the painted orbs, and each is keyed to a
 * `landingHomePrimitives` id so the copy stays the single source of words
 * and definitions. Colors live in `styles.css` as `--primitive-<id>` so the
 * orbit lights and the leader lines share one palette.
 */

export type LandingPrimitiveId = LandingHomePrimitive['id']

export const landingPrimitiveIds = [
	'memory',
	'secrets',
	'packages',
	'jobs',
	'integrations',
] as const satisfies ReadonlyArray<LandingPrimitiveId>

/** Kent's standalone lantern, trimmed to its alpha box. */
export const landingLanternImage = {
	src: '/images/kody-primitives-lantern-480.webp',
	srcSet: [
		'/images/kody-primitives-lantern-480.webp 480w',
		'/images/kody-primitives-lantern.webp 839w',
	].join(', '),
	sizes: '(max-width: 800px) 58vw, 17rem',
	width: 839,
	height: 1235,
} as const

/** Glass globe in the still: centre as fractions of width and height,
 *  radius as a fraction of width. Used to fade leaders inside the glass. */
export const landingLanternGlass = { x: 0.5, y: 0.545, r: 0.46 } as const

/** Orb centres in the still, percent of width and height. */
export const landingLanternOrbs = [
	{ id: 'memory', x: 50.2, y: 44 },
	{ id: 'secrets', x: 25.6, y: 53.2 },
	{ id: 'packages', x: 74.1, y: 53.4 },
	{ id: 'jobs', x: 31.9, y: 68.8 },
	{ id: 'integrations', x: 67.8, y: 68.8 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
}>

export type LandingLanternOrb = (typeof landingLanternOrbs)[number]

/** CSS custom property that carries a primitive's color. */
export function landingPrimitiveColorVar(id: LandingPrimitiveId) {
	return `var(--primitive-${id})`
}

/** Palette tone for the nth orbit light; cycles through the five colors. */
export function landingOrbitLightTone(index: number): LandingPrimitiveId {
	const count = landingPrimitiveIds.length
	return landingPrimitiveIds[((index % count) + count) % count]!
}

export type LandingLeaderPoint = { x: number; y: number }

/** Which edge of the word a leader lands on. */
export type LandingLeaderSide = 'top' | 'bottom'

/**
 * A leader lands on the edge of the word that faces its orb: words above the
 * orb are entered from below, words below it from above. The curve then
 * rises or falls once instead of looping past the word and back.
 */
export function landingLeaderSide(
	orb: LandingLeaderPoint,
	word: { top: number; bottom: number },
): LandingLeaderSide {
	const wordMid = (word.top + word.bottom) / 2
	return wordMid < orb.y ? 'bottom' : 'top'
}

/**
 * Cubic from an orb centre to the word anchor. It leaves the glass on a
 * horizontal tangent and arrives vertically, from above or below, so the
 * last stretch drops onto the word rather than running along the line of
 * text. Coordinates are pixels relative to the primitives section; the
 * SVG's viewBox is set to the section size so units map one to one.
 */
export function landingLeaderPath(
	from: LandingLeaderPoint,
	to: LandingLeaderPoint,
	side: LandingLeaderSide = 'bottom',
) {
	const dx = to.x - from.x
	const dy = to.y - from.y
	const reach = Math.max(Math.abs(dx) * 0.45, 24)
	const lift = Math.min(Math.max(Math.abs(dy) * 0.5, 18), 56)
	const c1 = { x: from.x + reach, y: from.y }
	const c2 = { x: to.x, y: side === 'top' ? to.y - lift : to.y + lift }
	return `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`
}

/** Word anchor: centred just past the chosen edge of the word box. */
export function landingLeaderWordAnchor(
	rect: { left: number; width: number; top: number; bottom: number },
	origin: { left: number; top: number },
	side: LandingLeaderSide = 'bottom',
): LandingLeaderPoint {
	return {
		x: rect.left + rect.width / 2 - origin.left,
		y:
			side === 'top' ? rect.top - origin.top - 4 : rect.bottom - origin.top + 4,
	}
}

/** Orb anchor: the orb's centre. */
export function landingLeaderOrbAnchor(
	rect: { left: number; top: number; width: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left + rect.width / 2 - origin.left,
		y: rect.top + rect.height / 2 - origin.top,
	}
}

/**
 * Where a leader leaves the orb: on the painted orb's rim, facing the
 * word, so the line does not cross the orb's own face. `radius` is the
 * hotspot radius; the painted orb sits just inside it.
 */
export function landingLeaderOrbExit(
	centre: LandingLeaderPoint,
	to: LandingLeaderPoint,
	radius: number,
): LandingLeaderPoint {
	const dx = to.x - centre.x
	const dy = to.y - centre.y
	const length = Math.hypot(dx, dy)
	if (length === 0) return centre
	const rim = radius * 0.86
	return {
		x: centre.x + (dx / length) * rim,
		y: centre.y + (dy / length) * rim,
	}
}

function round(value: number) {
	return Math.round(value * 10) / 10
}
