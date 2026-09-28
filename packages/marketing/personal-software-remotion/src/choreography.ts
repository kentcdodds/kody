import { type LandingPrimitiveId } from '../../../worker/universal/landing-lantern.ts'
import { type MarkId } from './components/mark.tsx'
import { bar, framesPerBeat, musicMap } from './timing.ts'

/**
 * Shared cue sheet. The lantern is one persistent layer across beats 2–4,
 * so the scenes that aim beams or marks at an orb read the same frames the
 * lantern uses to pulse. Beats 2–4 move one piece at a time: primitives,
 * then integrations, then words, then panels; the zoom settles before the
 * agent copy, and the agents leave before "stays lit".
 */
export const cues = {
	lanternAppear: musicMap.drop - 4,
	/** One primitive per beat, each with its label. */
	orbLit: {
		memory: bar(6, 1),
		secrets: bar(6, 2),
		packages: bar(6, 3),
		triggers: bar(7),
		integrations: bar(7, 1),
		apps: bar(7, 2),
	} satisfies Record<LandingPrimitiveId, number>,
	primitivesOut: bar(7, 3) + 10,
	arrivalFlight: 20,
	connectCopy: { enter: bar(10, 1), keep: bar(10, 3), kody: bar(11) },
	panelsIn: bar(11, 2),
	lanternToSide: { start: musicMap.preChorus, end: bar(13, 2) + 2 },
	appBuild: bar(14, 1) + 2,
	/** More apps spawn while the camera pulls back and the lantern takes the middle. */
	zoomOut: { start: bar(15, 1) + 3, end: bar(16, 2) + 4 },
	agentsCopy: bar(17),
	agentsFrom: bar(17, 2),
	staysLitCopy: bar(19),
	lanternToCenter: { start: bar(20, 3) - 8, end: bar(21, 1) + 8 },
	finalChord: musicMap.finalHit,
} as const

const arrivalAt = (index: number) => Math.round(bar(8, 2 + index * 1.5))

export type Arrival = {
	mark: MarkId
	label: string
	orb: LandingPrimitiveId
	at: number
	from: { x: number; y: number }
}

/** Beat 2: after the primitives, the services from beat 1 fly home one at a time. */
export const arrivals: ReadonlyArray<Arrival> = [
	{
		mark: 'google',
		label: 'Gmail + Calendar',
		orb: 'integrations',
		at: arrivalAt(0),
		from: { x: 1540, y: 250 },
	},
	{
		mark: 'github',
		label: 'GitHub',
		orb: 'integrations',
		at: arrivalAt(1),
		from: { x: 1780, y: 640 },
	},
	{
		mark: 'stripe',
		label: 'Stripe',
		orb: 'secrets',
		at: arrivalAt(2),
		from: { x: 110, y: 600 },
	},
	{
		mark: 'slack',
		label: 'Slack',
		orb: 'integrations',
		at: arrivalAt(3),
		from: { x: 1830, y: 880 },
	},
	{
		mark: 'linear',
		label: 'Linear',
		orb: 'secrets',
		at: arrivalAt(4),
		from: { x: 180, y: 240 },
	},
]

/** Beat 3: each dashboard card lights its data from an integration. */
export const cardFetches = [0, 1, 2, 3].map(
	(index) => cues.appBuild + 20 + index * 8,
)

/** Beat 4: one agent every two beats, each gone before "stays lit". */
export const agentVisits = [0, 1, 2].map((index) => {
	const at = cues.agentsFrom + index * framesPerBeat * 2
	return { in: at, out: at + framesPerBeat * 2 - 8 }
})

/** Beat 4: once "stays lit" lands, package schedules wake the grid. */
export const triggerTicks = [bar(19, 2), bar(19, 3), bar(20)]

export type OrbPulse = { orb: LandingPrimitiveId; at: number }

const spawnPulseOrbs = ['apps', 'integrations', 'packages'] as const

export const orbPulses: ReadonlyArray<OrbPulse> = [
	...arrivals.map((arrival) => ({ orb: arrival.orb, at: arrival.at })),
	{ orb: 'packages', at: cues.appBuild },
	{ orb: 'apps', at: cues.appBuild + 6 },
	...cardFetches.map((at) => ({ orb: 'integrations' as const, at })),
	...Array.from({ length: 12 }, (_, index) => ({
		orb: spawnPulseOrbs[index % spawnPulseOrbs.length]!,
		at: cues.zoomOut.start + 4 + index * 7,
	})),
	...triggerTicks.flatMap((at) => [
		{ orb: 'triggers' as const, at },
		{ orb: 'apps' as const, at: at + 8 },
	]),
	...(
		[
			'memory',
			'secrets',
			'packages',
			'triggers',
			'integrations',
			'apps',
		] as const
	).map((orb, index) => ({ orb, at: cues.finalChord + index * 3 })),
]
