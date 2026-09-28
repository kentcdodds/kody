/**
 * Edit map. The score (`scripts/generate-music.ts`) is 120 BPM, so one beat
 * is 15 frames and one bar is 60. Scene boundaries sit on bar lines.
 */
export const fps = 30
export const framesPerBeat = 15
export const framesPerBar = framesPerBeat * 4
export const durationInFrames = 14 * framesPerBar
export const width = 1920
export const height = 1080

export function bar(barNumber: number, beat = 0) {
	return (barNumber - 1) * framesPerBar + beat * framesPerBeat
}

/** `from` is where a scene starts; `until` is where it has fully left. */
export const scenes = {
	integrationTax: { from: 0, until: bar(5, 1) },
	connectOnce: { from: bar(4, 3), until: bar(8, 1) },
	generateApp: { from: bar(8), until: bar(11, 1) },
	staysLit: { from: bar(11), until: bar(13, 1) },
	tagline: { from: bar(12, 3), until: durationInFrames },
} as const

export const musicVolume = 0.68
