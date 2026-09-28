import { Easing, interpolate, spring } from 'remotion'
import { fps } from './timing.ts'

const clamp = {
	extrapolateLeft: 'clamp',
	extrapolateRight: 'clamp',
} as const

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1)
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1)
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0)

/** 0 → 1 between two frames with an ease, clamped on both sides. */
export function progress(
	frame: number,
	start: number,
	end: number,
	easing: (t: number) => number = easeOut,
) {
	return interpolate(frame, [start, end], [0, 1], { ...clamp, easing })
}

export function mix(from: number, to: number, amount: number) {
	return from + (to - from) * amount
}

/** Springy settle that starts at `delay`. Soft by default, not bouncy. */
export function settle(
	frame: number,
	delay: number,
	config: { damping?: number; stiffness?: number; mass?: number } = {},
) {
	return spring({
		frame: frame - delay,
		fps,
		config: { damping: 18, stiffness: 120, mass: 0.9, ...config },
	})
}

/** Fade in over `enter`, hold, fade out over `exit`. */
export function presence(
	frame: number,
	window: { in: number; out: number; enter?: number; exit?: number },
) {
	const enter = window.enter ?? 12
	const exit = window.exit ?? 12
	const fadeIn = progress(frame, window.in, window.in + enter)
	const fadeOut = 1 - progress(frame, window.out, window.out + exit, easeIn)
	return Math.min(fadeIn, fadeOut)
}

/** A 0 → 1 → 0 bump used for pulses and flashes. */
export function pulse(frame: number, at: number, length = 18) {
	if (frame < at || frame > at + length) return 0
	const t = (frame - at) / length
	return Math.sin(Math.PI * t) ** 2 * (1 - t * 0.3)
}

export type Point = { x: number; y: number }

export function quadraticPoint(
	from: Point,
	control: Point,
	to: Point,
	t: number,
): Point {
	const inverse = 1 - t
	return {
		x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
		y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
	}
}

export function countUp(frame: number, start: number, end: number, to: number) {
	return Math.round(progress(frame, start, end, easeInOut) * to)
}
