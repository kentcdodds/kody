import { type LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Five-orb lantern geometry for the homepage primitives section. Orb
 * positions are percentages of the lantern stage; each orb is keyed to a
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

export type LandingLanternGlyph = 'brain' | 'lock' | 'cube' | 'gear' | 'plug'

export const landingLanternOrbs = [
	{ id: 'memory', glyph: 'brain', x: 50, y: 44 },
	{ id: 'secrets', glyph: 'lock', x: 26, y: 60 },
	{ id: 'packages', glyph: 'cube', x: 74, y: 60 },
	{ id: 'jobs', glyph: 'gear', x: 34, y: 80 },
	{ id: 'integrations', glyph: 'plug', x: 66, y: 80 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	glyph: LandingLanternGlyph
	x: number
	y: number
}>

export type LandingLanternOrb = (typeof landingLanternOrbs)[number]

/**
 * The same five orbs inside the lantern Kody holds on the proof stage, as
 * fractions of the glass radii (0 is the glass centre, 1 the rim). Used to
 * paint the orbs over the hero still so both lanterns read as one object.
 */
export const landingKodyLanternOrbs = [
	{ id: 'memory', dx: 0, dy: -0.5 },
	{ id: 'secrets', dx: -0.56, dy: -0.06 },
	{ id: 'packages', dx: 0.56, dy: -0.06 },
	{ id: 'jobs', dx: -0.34, dy: 0.46 },
	{ id: 'integrations', dx: 0.34, dy: 0.46 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	dx: number
	dy: number
}>

/** Glass radii of the lantern in the hero still, in stage percent. */
export const landingKodyLanternGlass = { rx: 6.3, ry: 5.4 } as const

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

function round(value: number) {
	return Math.round(value * 10) / 10
}
