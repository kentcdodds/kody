import { type LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Six-orb lantern for the homepage primitives section. The shell (glass
 * and glow), the metal frame, and each primitive orb are separate layers,
 * keyed to a `landingHomePrimitives` id so the copy stays the single source
 * of words and definitions. Orb centres are percentages of the shell.
 * Colors live in `styles.css` as `--primitive-<id>` so the orbit lights
 * and the leader lines share one palette.
 */

export type LandingPrimitiveId = LandingHomePrimitive['id']

export const landingPrimitiveIds = [
	'memory',
	'secrets',
	'packages',
	'triggers',
	'integrations',
	'apps',
] as const satisfies ReadonlyArray<LandingPrimitiveId>

/** Glass and glow only. The metal cap, handle, and base are a second
 *  layer (`landingLanternFrame`) so they paint above the orbs. */
export const landingLanternImage = {
	src: '/images/lantern/kody-primitives-lantern-shell-480.webp',
	srcSet: [
		'/images/lantern/kody-primitives-lantern-shell-480.webp 480w',
		'/images/lantern/kody-primitives-lantern-shell.webp 863w',
	].join(', '),
	sizes: '(max-width: 800px) 58vw, 17rem',
	width: 863,
	height: 1242,
} as const

/** Metal cap, handle, and base, aligned to `landingLanternImage`. */
export const landingLanternFrame = {
	src: '/images/lantern/kody-primitives-lantern-frame-480.webp',
	srcSet: [
		'/images/lantern/kody-primitives-lantern-frame-480.webp 480w',
		'/images/lantern/kody-primitives-lantern-frame.webp 863w',
	].join(', '),
	sizes: landingLanternImage.sizes,
	width: landingLanternImage.width,
	height: landingLanternImage.height,
} as const

/** Orb cutouts. Each sprite is centered on its disc in the shell. */
export const landingLanternOrbArt = {
	memory: '/images/lantern/kody-primitives-orb-memory.webp',
	secrets: '/images/lantern/kody-primitives-orb-secrets.webp',
	packages: '/images/lantern/kody-primitives-orb-packages.webp',
	triggers: '/images/lantern/kody-primitives-orb-triggers.webp',
	integrations: '/images/lantern/kody-primitives-orb-integrations.webp',
	apps: '/images/lantern/kody-primitives-orb-apps.webp',
} as const satisfies Record<LandingPrimitiveId, string>

/** Glass globe in the shell: centre as fractions of width and height,
 *  radius as a fraction of width. Used to fade leaders inside the glass. */
export const landingLanternGlass = { x: 0.5, y: 0.545, r: 0.46 } as const

/**
 * Glass the orbs may paint on, as fractions of lantern height. Tighter than
 * the outer metal (`landingLanternAperture` in the motion module): the dark
 * lip under the cap and on the pedestal is in the shell, behind the orbs,
 * so the frame does not cover it. Measured where that lip gives way to the
 * bright glass.
 */
export const landingLanternGlowAperture = {
	top: 0.326,
	bottom: 0.822,
} as const

/**
 * Orb centres (percent of width and height), shared disc diameter (percent
 * of width), and sprite width (percent of width). `size` is the painted
 * disc, so the hotspot, ring, collision radius, and leader rim match it.
 * `art` is the slightly larger sprite, cropped so that disc sits in the
 * middle of the image. Six discs at 16.2 stay inside the glass with room
 * to drift.
 */
export const landingLanternOrbs = [
	{ id: 'memory', x: 50, y: 38.5, size: 16.2, art: 16.94 },
	{ id: 'secrets', x: 29, y: 50, size: 16.2, art: 16.94 },
	{ id: 'packages', x: 71, y: 50, size: 16.2, art: 16.95 },
	{ id: 'triggers', x: 34, y: 63, size: 16.2, art: 16.94 },
	{ id: 'integrations', x: 66, y: 63, size: 16.2, art: 16.93 },
	{ id: 'apps', x: 50, y: 74.5, size: 16.2, art: 16.91 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
	size: number
	art: number
}>

/**
 * Clip for the orb layer. The sprite halo, pulse ring, and hover bloom all
 * paint with the discs, and the shell lip sits behind them, so the clip has
 * to cover the glow and not only the hard disc. Polygon of the glass ellipse
 * cut by `landingLanternGlowAperture`, in percentages of the lantern box.
 */
export function landingLanternOrbClipPath() {
	const { width, height } = landingLanternImage
	const rx = landingLanternGlass.r
	const ry = landingLanternGlass.r * (width / height)
	const { x: cx, y: cy } = landingLanternGlass
	const top = landingLanternGlowAperture.top
	const bottom = landingLanternGlowAperture.bottom
	const points: Array<readonly [number, number]> = []
	const nyTop = (top - cy) / ry
	const nyBottom = (bottom - cy) / ry
	const xOnEllipse = (ny: number, side: -1 | 1) =>
		cx + side * Math.sqrt(Math.max(0, 1 - ny * ny)) * rx
	const topLeft: readonly [number, number] = [xOnEllipse(nyTop, -1), top]
	const topRight: readonly [number, number] = [xOnEllipse(nyTop, 1), top]
	const bottomRight: readonly [number, number] = [
		xOnEllipse(nyBottom, 1),
		bottom,
	]
	const bottomLeft: readonly [number, number] = [
		xOnEllipse(nyBottom, -1),
		bottom,
	]
	points.push(topLeft, topRight)
	pushArc(points, topRight, bottomRight, cx, cy, rx, ry)
	points.push(bottomRight, bottomLeft)
	pushArc(points, bottomLeft, topLeft, cx, cy, rx, ry)
	const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
	return `polygon(${points
		.map(([x, y]) => `${percent(x)} ${percent(y)}`)
		.join(',')})`
}

/** Walk the glass ellipse clockwise from `from` to `to`, not repeating ends. */
function pushArc(
	points: Array<readonly [number, number]>,
	from: readonly [number, number],
	to: readonly [number, number],
	cx: number,
	cy: number,
	rx: number,
	ry: number,
) {
	const angle = (point: readonly [number, number]) =>
		Math.atan2((point[1] - cy) / ry, (point[0] - cx) / rx)
	let start = angle(from)
	let end = angle(to)
	if (end <= start) end += Math.PI * 2
	const steps = 10
	for (let step = 1; step < steps; step++) {
		const theta = start + ((end - start) * step) / steps
		points.push([cx + Math.cos(theta) * rx, cy + Math.sin(theta) * ry])
	}
}

/** CSS custom property that carries a primitive's color. */
export function landingPrimitiveColorVar(id: LandingPrimitiveId) {
	return `var(--primitive-${id})`
}

/** Palette tone for the nth orbit light; cycles through the six colors. */
export function landingOrbitLightTone(index: number): LandingPrimitiveId {
	const count = landingPrimitiveIds.length
	return landingPrimitiveIds[((index % count) + count) % count]!
}

export type LandingLeaderPoint = { x: number; y: number }

/**
 * Cubic from an orb to the word's dot with horizontal tangents at both
 * ends: it leaves the glass sideways and glides into the dot from the
 * left. Coordinates are pixels relative to the stage; the SVG's viewBox is
 * set to the stage size so units map one to one.
 */
export function landingLeaderPath(
	from: LandingLeaderPoint,
	to: LandingLeaderPoint,
) {
	const dx = to.x - from.x
	const reach = Math.max(Math.abs(dx) * 0.5, 24)
	const c1 = { x: from.x + reach, y: from.y }
	const c2 = { x: to.x - reach * 0.6, y: to.y }
	return `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`
}

/** Word anchor: the left edge of the colored dot before the word. */
export function landingLeaderWordAnchor(
	rect: { left: number; top: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left - origin.left - 2,
		y: rect.top + rect.height / 2 - origin.top,
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
