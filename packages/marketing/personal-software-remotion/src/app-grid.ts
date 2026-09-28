import { cues, triggerTicks } from './choreography.ts'
import { type MarkId } from './components/mark.tsx'
import { easeInOut, mix, progress, type Point } from './motion.ts'
import { height, width } from './timing.ts'

/**
 * World for the many-apps pull-back. One world pixel equals one screen pixel
 * at scale 1, when only the first app is on screen. Cell (0, 0) is the hub
 * the lantern settles into; the middle two columns stay empty around it.
 */
export const tileSize = { width: 1190, height: 744 }
const pitch = { x: 1320, y: 864 }

const firstAppScreen = { x: 594 + 595, y: 286 + 372 }
const firstAppCell = { column: 1.5, row: -0.5 }
const firstAppWorld = {
	x: firstAppCell.column * pitch.x,
	y: firstAppCell.row * pitch.y,
}

const zoomedScale = 0.14
export const hubScreen = { x: 960, y: 640 }

/** Screen offset of world (0, 0) at scale 1: the first app lines up with its beat 3 spot. */
export const worldOriginAtRest = {
	x: firstAppScreen.x - firstAppWorld.x,
	y: firstAppScreen.y - firstAppWorld.y,
}

export type Camera = { x: number; y: number; scale: number }

/**
 * Zoom keeps the first app moving on a straight line to its grid cell while
 * the scale falls exponentially, so the pull-back reads as one smooth move.
 */
export function camera(frame: number): Camera {
	const t = progress(frame, cues.zoomOut.start, cues.zoomOut.end, easeInOut)
	const drift = progress(
		frame,
		cues.lanternToCenter.start,
		cues.lanternToCenter.end + 60,
		easeInOut,
	)
	const scale = Math.exp(Math.log(zoomedScale) * t) * mix(1, 0.88, drift)
	const anchorEnd = {
		x: hubScreen.x + firstAppWorld.x * zoomedScale,
		y: hubScreen.y + firstAppWorld.y * zoomedScale,
	}
	const anchor = {
		x: mix(firstAppScreen.x, anchorEnd.x, t),
		y: mix(firstAppScreen.y, anchorEnd.y, t),
	}
	const x = anchor.x - scale * firstAppWorld.x
	const y = anchor.y - scale * firstAppWorld.y
	return {
		x: mix(x, hubScreen.x, drift),
		y: mix(y, hubScreen.y, drift),
		scale,
	}
}

export function toScreen(view: Camera, world: Point): Point {
	return { x: view.x + world.x * view.scale, y: view.y + world.y * view.scale }
}

/** Beat 3 screen coordinates (scale 1) mapped through the current camera. */
export function fromRestScreen(view: Camera, point: Point): Point {
	return toScreen(view, {
		x: point.x - worldOriginAtRest.x,
		y: point.y - worldOriginAtRest.y,
	})
}

type TileKind = 'bars' | 'spark' | 'list'

export type AppTile = {
	index: number
	name: string
	slug: string
	stat: string
	caption: string
	marks: ReadonlyArray<MarkId>
	kind: TileKind
	center: Point
	spawnAt: number
	first: boolean
}

const catalog: ReadonlyArray<
	Omit<AppTile, 'index' | 'slug' | 'center' | 'spawnAt' | 'first' | 'kind'>
> = [
	{
		name: 'Habit Tracker',
		stat: '23 days',
		caption: 'current streak',
		marks: ['google'],
	},
	{
		name: 'Invoice Bot',
		stat: '$4,200',
		caption: 'due this week',
		marks: ['stripe', 'google'],
	},
	{
		name: 'Family Calendar',
		stat: '6 events',
		caption: 'this weekend',
		marks: ['google'],
	},
	{
		name: 'PR Radar',
		stat: '4 PRs',
		caption: 'need your review',
		marks: ['github', 'slack'],
	},
	{
		name: 'Podcast Planner',
		stat: 'Ep. 142',
		caption: 'records Thursday',
		marks: ['google', 'spotify'],
	},
	{
		name: 'Workout Log',
		stat: '5 / 5',
		caption: 'workouts this week',
		marks: ['spotify'],
	},
	{
		name: 'Budget',
		stat: '$1,380',
		caption: 'left in October',
		marks: ['stripe'],
	},
	{
		name: 'Issue Triage',
		stat: '12 new',
		caption: 'sorted by label',
		marks: ['linear', 'github'],
	},
	{
		name: 'Travel Planner',
		stat: '3 trips',
		caption: 'flights on hold',
		marks: ['google'],
	},
	{
		name: 'Standup Notes',
		stat: '8 updates',
		caption: 'posted to #team',
		marks: ['slack', 'linear'],
	},
	{
		name: 'Chore Chart',
		stat: '14 / 18',
		caption: 'chores done',
		marks: ['google'],
	},
	{
		name: 'Release Notes',
		stat: 'v2.4.0',
		caption: 'drafted from PRs',
		marks: ['github'],
	},
	{
		name: 'Meal Planner',
		stat: '7 dinners',
		caption: 'list sent to inbox',
		marks: ['google'],
	},
	{
		name: 'Focus Playlist',
		stat: '2h 10m',
		caption: 'deep work today',
		marks: ['spotify', 'google'],
	},
	{
		name: 'Support Inbox',
		stat: '3 open',
		caption: 'replies drafted',
		marks: ['google', 'slack'],
	},
	{
		name: 'Sales Pulse',
		stat: '+18%',
		caption: 'week over week',
		marks: ['stripe', 'slack'],
	},
	{
		name: 'Sprint Board',
		stat: '21 pts',
		caption: 'left this sprint',
		marks: ['linear'],
	},
	{
		name: 'Weekly Review',
		stat: '9 wins',
		caption: 'from the whole week',
		marks: ['google', 'github', 'stripe'],
	},
	{
		name: 'Reading List',
		stat: '11 saved',
		caption: 'queued for Sunday',
		marks: ['google'],
	},
	{
		name: 'Refund Watch',
		stat: '0 disputes',
		caption: 'in 30 days',
		marks: ['stripe'],
	},
	{
		name: 'Repo Janitor',
		stat: '37 branches',
		caption: 'cleaned up',
		marks: ['github'],
	},
	{
		name: 'Bug Bash',
		stat: '15 fixed',
		caption: 'this afternoon',
		marks: ['linear', 'slack'],
	},
	{
		name: 'Gift Ideas',
		stat: '5 people',
		caption: 'birthdays soon',
		marks: ['google'],
	},
	{
		name: 'Office Hours',
		stat: '4 booked',
		caption: 'Friday slots',
		marks: ['google', 'slack'],
	},
	{
		name: 'Course Sales',
		stat: '$9,870',
		caption: 'launch week',
		marks: ['stripe', 'google'],
	},
	{
		name: 'On-call Brief',
		stat: 'All clear',
		caption: 'no pages overnight',
		marks: ['slack', 'github'],
	},
]

const kinds: ReadonlyArray<TileKind> = ['bars', 'spark', 'list']

function cellCenters() {
	const cells: Array<{ column: number; row: number }> = []
	for (let column = -4.5; column <= 4.5; column++) {
		for (let row = -2.5; row <= 2.5; row++) {
			const hub = Math.abs(column) === 0.5 && Math.abs(row) <= 1.5
			if (hub) continue
			cells.push({ column, row })
		}
	}
	return cells
}

function visibleFrom(center: Point) {
	for (let frame = cues.zoomOut.start; frame <= cues.zoomOut.end; frame++) {
		const view = camera(frame)
		const screen = toScreen(view, center)
		const halfWidth = (tileSize.width / 2) * view.scale
		const halfHeight = (tileSize.height / 2) * view.scale
		const inside =
			screen.x - halfWidth > -halfWidth * 0.4 &&
			screen.x + halfWidth < width + halfWidth * 0.4 &&
			screen.y - halfHeight > -halfHeight * 0.4 &&
			screen.y + halfHeight < height + halfHeight * 0.4
		if (inside) return frame
	}
	return cues.zoomOut.end
}

function slugify(name: string) {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export const appTiles: ReadonlyArray<AppTile> = cellCenters()
	.map((cell) => ({
		...cell,
		center: { x: cell.column * pitch.x, y: cell.row * pitch.y },
		first: cell.column === firstAppCell.column && cell.row === firstAppCell.row,
	}))
	.filter((cell) => !cell.first)
	.map((cell) => ({ ...cell, visible: visibleFrom(cell.center) }))
	.sort((a, b) => a.visible - b.visible)
	.map((cell, index) => {
		const entry = catalog[index % catalog.length]!
		return {
			...entry,
			index,
			slug: slugify(entry.name),
			kind: kinds[index % kinds.length]!,
			center: cell.center,
			spawnAt: Math.max(cues.zoomOut.start + 3, cell.visible + (index % 3)),
			first: false,
		}
	})

export const firstAppTile = {
	center: firstAppWorld,
	spawnAt: cues.appBuild,
}

/** Which apps a scheduled trigger wakes on each tick (a third of the grid each time). */
export function tickTargets(tickIndex: number) {
	return appTiles.filter(
		(tile) => tile.index % triggerTicks.length === tickIndex,
	)
}
