import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * Messages between the page and the 3D lantern's worker. Points are CSS
 * pixels from the canvas's top left, and times are the page's
 * `performance.now()`, so a flick measures the gesture rather than how
 * fast its messages arrived.
 */

export type LanternBox = {
	left: number
	top: number
	width: number
	height: number
}

export type LanternViewport = {
	/** The canvas in CSS pixels. */
	width: number
	height: number
	/** The lantern's layout box (where the 2D still sits), inside the canvas. */
	frame: LanternBox
	devicePixelRatio: number
}

export type LanternPalette = {
	/** CSS colors, as `--primitive-<id>` resolves on the page. */
	colors: Record<LandingPrimitiveId, string>
	dark: boolean
}

export type LanternMotion = {
	reduced: boolean
	/** Share of the full wander; small screens use less. */
	wander: number
}

export type LanternPoint = {
	id: LandingPrimitiveId
	x: number
	y: number
}

type LanternOrbFrame = {
	id: LandingPrimitiveId
	/** Centre in CSS pixels from the frame's top left. */
	x: number
	y: number
	/** Projected radius in CSS pixels. */
	radius: number
	/** 1 is the farthest orb. */
	order: number
}

export type LanternSceneFrame = {
	orbs: ReadonlyArray<LanternOrbFrame>
	width: number
	height: number
}

export type LanternHostMessage =
	| {
			type: 'start'
			canvas: OffscreenCanvas
			viewport: LanternViewport
			palette: LanternPalette
			motion: LanternMotion
			/** Where the 2D orbs are, in frame pixels: the first frame matches. */
			orbs: ReadonlyArray<LanternPoint>
			visible: boolean
			paused: boolean
	  }
	| { type: 'layout'; viewport: LanternViewport }
	| { type: 'palette'; palette: LanternPalette }
	| { type: 'motion'; motion: LanternMotion }
	| { type: 'visible'; visible: boolean }
	/** A navigation is under way: no startup steps and no frames. */
	| { type: 'pause'; paused: boolean }
	| { type: 'active'; id: LandingPrimitiveId | null }
	| { type: 'celebrate'; id: LandingPrimitiveId }
	| { type: 'nudge' }
	| { type: 'spin'; direction: number; big: boolean }
	| { type: 'turn-start'; x: number; y: number; t: number }
	| { type: 'turn'; x: number; y: number; t: number }
	| { type: 'turn-end'; flick: boolean; t: number }
	| { type: 'grab'; id: LandingPrimitiveId; x: number; y: number; t: number }
	| { type: 'drag'; x: number; y: number; t: number }
	| { type: 'drop'; flick: boolean; t: number }
	| { type: 'look'; x: number; y: number }
	| { type: 'look-away' }

export type LanternWorkerMessage =
	| { type: 'ready'; frame: LanternSceneFrame }
	| { type: 'frame'; frame: LanternSceneFrame }
	/** No WebGL2 here, startup threw, or the GPU context was lost. */
	| { type: 'failed' }
