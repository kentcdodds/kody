/**
 * Shared agent-orbit geometry for the homepage hero and Satori OG cards.
 * Coordinates are percentages of the square stage; the lantern is the tether
 * endpoint inside the Kody image.
 */

export const landingLantern = { x: 57, y: 49.4 } as const

export const landingOrbitAgents = [
	{ label: 'Cursor', icon: 'cursor', x: 12, y: 19 },
	{ label: 'Claude Code', icon: 'claudecode', x: 88, y: 19 },
	{ label: 'ChatGPT', icon: 'chatgpt', x: 93, y: 46 },
	{ label: 'Copilot', icon: 'githubcopilot', x: 87, y: 72 },
	{ label: 'Claude', icon: 'claude', x: 74, y: 92 },
	{ label: 'Devin', icon: 'devin', x: 26, y: 92 },
	{ label: 'Grok Bot', icon: 'grokbot', x: 13, y: 72 },
	{ label: 'OpenCode', icon: 'opencode', x: 7, y: 46 },
] as const

export type LandingOrbitAgentIcon = (typeof landingOrbitAgents)[number]['icon']

/** Static stills of the travelling lantern lights for OG (no animation). */
export const landingOrbitOgLights = [
	{ icon: 'cursor' as const, progress: 0.28, scale: 1 },
	{ icon: 'chatgpt' as const, progress: 0.46, scale: 0.9 },
	{ icon: 'claude' as const, progress: 0.62, scale: 0.78 },
]

/** Cubic bézier control points matching the live hero tetherPath(). */
export function landingOrbitTetherControls(
	x: number,
	y: number,
	hx: number,
	hy: number,
) {
	const dx = hx - x
	const dy = hy - y
	return {
		p0: { x, y },
		p1: { x: x + dx * 0.1, y: y + dy * 0.6 },
		p2: { x: hx - dx * 0.45, y: hy - dy * 0.05 },
		p3: { x: hx, y: hy },
	}
}

export function landingOrbitTetherPath(
	x: number,
	y: number,
	hx: number,
	hy: number,
) {
	const { p0, p1, p2, p3 } = landingOrbitTetherControls(x, y, hx, hy)
	return `M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`
}

/** Point along the same cubic used by the live tethers (`progress` in 0–1). */
export function landingOrbitTetherPoint(
	x: number,
	y: number,
	hx: number,
	hy: number,
	progress: number,
) {
	const t = Math.min(1, Math.max(0, progress))
	const { p0, p1, p2, p3 } = landingOrbitTetherControls(x, y, hx, hy)
	const u = 1 - t
	return {
		x:
			u * u * u * p0.x +
			3 * u * u * t * p1.x +
			3 * u * t * t * p2.x +
			t * t * t * p3.x,
		y:
			u * u * u * p0.y +
			3 * u * u * t * p1.y +
			3 * u * t * t * p2.y +
			t * t * t * p3.y,
	}
}
