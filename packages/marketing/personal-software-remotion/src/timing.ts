/**
 * Edit map. The soundtrack (`scripts/build-soundtrack.ts`) is retimed to
 * 120 BPM, so one beat is 15 frames and one bar is 60. Scene boundaries sit
 * on bar lines.
 */
export const fps = 30
export const framesPerBeat = 15
export const framesPerBar = framesPerBeat * 4
export const durationInFrames = 885
export const width = 1920
export const height = 1080

export function bar(barNumber: number, beat = 0) {
	return (barNumber - 1) * framesPerBar + beat * framesPerBeat
}

/** `from` is where a scene starts; `until` is where it has fully left. */
export const scenes = {
	integrationTax: { from: 0, until: bar(6, 1) },
	connectOnce: { from: bar(5, 3), until: bar(9, 1) },
	generateApp: { from: bar(9), until: bar(12, 3) },
	appWorld: { from: bar(9), until: durationInFrames },
	staysLit: { from: bar(12, 2), until: bar(14, 1) },
	tagline: { from: bar(13, 3), until: durationInFrames },
} as const
