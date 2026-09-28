import { type LandingPrimitiveId } from '../../../worker/universal/landing-lantern.ts'
import { type MarkId } from './components/mark.tsx'
import { bar } from './timing.ts'

/**
 * Shared cue sheet. The lantern is one persistent layer across beats 2–4,
 * so the scenes that aim beams or marks at an orb read the same frames the
 * lantern uses to pulse.
 */
export const cues = {
	lanternAppear: bar(6) - 4,
	orbLit: {
		memory: bar(6) + 4,
		secrets: bar(6) + 10,
		packages: bar(6) + 16,
		triggers: bar(6) + 22,
		integrations: bar(6) + 28,
		apps: bar(6) + 34,
	} satisfies Record<LandingPrimitiveId, number>,
	lanternToSide: { start: bar(9), end: bar(9, 2) + 2 },
	appBuild: bar(10, 1) + 2,
	/** More apps spawn while the camera pulls back and the lantern takes the middle. */
	zoomOut: { start: bar(11, 1) + 3, end: bar(12, 2) + 4 },
	lanternToCenter: { start: bar(13, 3) - 8, end: bar(14, 1) + 8 },
	finalChord: bar(14),
} as const

export type Arrival = {
	mark: MarkId
	label: string
	orb: LandingPrimitiveId
	at: number
	from: { x: number; y: number }
}

/** Beat 2: the services from beat 1 fly home, one per eighth note. */
export const arrivals: ReadonlyArray<Arrival> = [
	{
		mark: 'google',
		label: 'Gmail + Calendar',
		orb: 'integrations',
		at: bar(6, 3),
		from: { x: 1540, y: 250 },
	},
	{
		mark: 'github',
		label: 'GitHub',
		orb: 'integrations',
		at: bar(6, 3.5),
		from: { x: 1780, y: 640 },
	},
	{
		mark: 'stripe',
		label: 'Stripe',
		orb: 'secrets',
		at: bar(7),
		from: { x: 110, y: 600 },
	},
	{
		mark: 'slack',
		label: 'Slack',
		orb: 'integrations',
		at: bar(7, 0.5),
		from: { x: 1830, y: 880 },
	},
	{
		mark: 'linear',
		label: 'Linear',
		orb: 'secrets',
		at: bar(7, 1),
		from: { x: 180, y: 240 },
	},
]

/** Beat 3: each dashboard card lights its data from an integration. */
export const cardFetches = [0, 1, 2, 3].map(
	(index) => cues.appBuild + 20 + index * 8,
)

/** Beat 4: package schedules fire across the grid with no agent attached. */
export const triggerTicks = [bar(12, 3), bar(13), bar(13, 2)]

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
