import { scenes } from './timing.ts'

/**
 * Beat 1 cue sheet, in frames. One full cycle (wire, build, deploy) at a
 * readable pace, then the same wiring again, faster each time, until "Ugh"
 * lands just before the drop. Plain data so the soundtrack builder
 * (`scripts/build-soundtrack.ts`) can read it too.
 */
export const openingCues = {
	firstApp: 4,
	needApp: 8,
	checklist: 32,
	wire: { start: 44, cards: 48, every: 12 },
	build: { start: 108, end: 128 },
	deploy: { start: 128, end: 142, live: 134 },
	needAnother: 150,
	again: 180,
	andAgain: [210, 226, 240],
	ugh: 256,
	exit: scenes.integrationTax.until - 37,
} as const

export const checklist = [
	{
		label: 'Wire up integrations',
		start: openingCues.wire.start,
		done: openingCues.build.start,
	},
	{
		label: 'Build',
		start: openingCues.build.start,
		done: openingCues.build.end,
	},
	{
		label: 'Deploy',
		start: openingCues.deploy.start,
		done: openingCues.deploy.end,
	},
] as const

type Placement = { x: number; y: number; scale: number }

export type AppShell = {
	title: string
	address: string
	enterAt: number
	/** Landing frame for each setup card, in `setupCards` order. */
	cardTimes: ReadonlyArray<number>
	rest: Placement
	stacked?: Placement & { at: number }
	shipped?: { address: string }
	slump: number
}

function slot(index: number): Placement {
	return { x: 1080 + index * 150, y: 250 + index * 150, scale: 0.44 }
}

const cardsEvery = (start: number, step: number, count = 5) =>
	Array.from({ length: count }, (_, index) => Math.round(start + index * step))

const { andAgain } = openingCues

export const shells: ReadonlyArray<AppShell> = [
	{
		title: 'family-hq',
		address: 'localhost:3000',
		enterAt: openingCues.firstApp,
		cardTimes: cardsEvery(openingCues.wire.cards, openingCues.wire.every),
		rest: { x: 1250, y: 560, scale: 1 },
		stacked: { ...slot(0), at: openingCues.needAnother },
		shipped: { address: 'family-hq.app' },
		slump: -2,
	},
	{
		title: 'habit-tracker',
		address: 'localhost:5173',
		enterAt: openingCues.needAnother + 6,
		cardTimes: cardsEvery(openingCues.again + 2, 5),
		rest: { x: 1310, y: 630, scale: 0.8 },
		stacked: { ...slot(1), at: andAgain[0] - 4 },
		slump: 2.5,
	},
	{
		title: 'invoice-bot',
		address: 'localhost:8787',
		enterAt: andAgain[0] - 3,
		cardTimes: cardsEvery(andAgain[0] + 1, 3),
		rest: slot(2),
		slump: -1.5,
	},
	{
		title: 'meal-planner',
		address: 'localhost:4321',
		enterAt: andAgain[1] - 2,
		cardTimes: cardsEvery(andAgain[1] + 1, 2.5),
		rest: slot(3),
		slump: 3,
	},
	{
		title: 'podcast-notes',
		address: 'localhost:8000',
		enterAt: andAgain[2] - 2,
		cardTimes: cardsEvery(andAgain[2] + 1, 2, 6),
		rest: slot(4),
		slump: -2.5,
	},
]
