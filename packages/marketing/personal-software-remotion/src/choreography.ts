import { type LandingPrimitiveId } from '../../../worker/universal/landing-lantern.ts'
import { type MarkId } from './components/mark.tsx'
import { bar } from './timing.ts'

/**
 * Shared cue sheet. The lantern is one persistent layer across beats 2–4,
 * so the scenes that aim beams or marks at an orb read the same frames the
 * lantern uses to pulse.
 */
export const cues = {
	lanternAppear: bar(5) - 4,
	orbLit: {
		memory: bar(5) + 4,
		secrets: bar(5) + 10,
		packages: bar(5) + 16,
		triggers: bar(5) + 22,
		integrations: bar(5) + 28,
		apps: bar(5) + 34,
	} satisfies Record<LandingPrimitiveId, number>,
	lanternToSide: { start: bar(8), end: bar(8, 2) + 2 },
	appBuild: bar(9, 1) + 12,
	lanternToCenter: { start: bar(12, 3) - 8, end: bar(13, 1) + 8 },
	finalChord: bar(13),
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
		at: bar(5, 3),
		from: { x: 1540, y: 250 },
	},
	{
		mark: 'github',
		label: 'GitHub',
		orb: 'integrations',
		at: bar(5, 3.5),
		from: { x: 1780, y: 640 },
	},
	{
		mark: 'stripe',
		label: 'Stripe',
		orb: 'secrets',
		at: bar(6),
		from: { x: 110, y: 600 },
	},
	{
		mark: 'slack',
		label: 'Slack',
		orb: 'integrations',
		at: bar(6, 0.5),
		from: { x: 1830, y: 880 },
	},
	{
		mark: 'linear',
		label: 'Linear',
		orb: 'secrets',
		at: bar(6, 1),
		from: { x: 180, y: 240 },
	},
]

/** Beat 3: each dashboard card lights its data from an integration. */
export const cardFetches = [0, 1, 2, 3].map(
	(index) => cues.appBuild + 20 + index * 8,
)

/** Beat 4: the package's own schedule fires with no agent attached. */
export const triggerTicks = [bar(11, 1), bar(11, 3), bar(12, 1)]

export type OrbPulse = { orb: LandingPrimitiveId; at: number }

export const orbPulses: ReadonlyArray<OrbPulse> = [
	...arrivals.map((arrival) => ({ orb: arrival.orb, at: arrival.at })),
	{ orb: 'packages', at: cues.appBuild },
	{ orb: 'apps', at: cues.appBuild + 6 },
	...cardFetches.map((at) => ({ orb: 'integrations' as const, at })),
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
