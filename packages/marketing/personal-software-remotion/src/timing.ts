/**
 * Edit map. The soundtrack (`scripts/build-soundtrack.ts`) is retimed to
 * 120 BPM, so one beat is 15 frames and one bar is 60. Scene boundaries sit
 * on bar lines.
 */
export const fps = 30
export const framesPerBeat = 15
export const framesPerBar = framesPerBeat * 4
export const width = 1920
export const height = 1080

export function bar(barNumber: number, beat = 0) {
	return (barNumber - 1) * framesPerBar + beat * framesPerBeat
}

/**
 * Where the soundtrack's sections land: the drop as the lantern lights, the
 * pre-chorus bar under the prompt (chorus one bar later), and the song's
 * final hit under the tagline. Change these and rebuild the soundtrack.
 */
export const musicMap = {
	drop: bar(6),
	preChorus: bar(13),
	finalHit: bar(21),
} as const

export const durationInFrames = musicMap.finalHit + 105

/** `from` is where a scene starts; `until` is where it has fully left. */
export const scenes = {
	integrationTax: { from: 0, until: bar(6, 1) },
	connectOnce: { from: bar(5, 3), until: bar(13, 1) },
	generateApp: { from: bar(13), until: bar(17, 1) },
	appWorld: { from: bar(13), until: durationInFrames },
	staysLit: { from: bar(17), until: bar(21, 1) },
	tagline: { from: bar(20, 3), until: durationInFrames },
} as const
