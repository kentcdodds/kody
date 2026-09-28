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

export type ScreenKind =
	| 'approvals'
	| 'booking'
	| 'budget'
	| 'call'
	| 'chat'
	| 'chores'
	| 'diff'
	| 'editor'
	| 'flashcards'
	| 'grocery'
	| 'habit'
	| 'home'
	| 'invoice'
	| 'journal'
	| 'kanban'
	| 'photos'
	| 'player'
	| 'poll'
	| 'route'
	| 'seat'
	| 'sketch'
	| 'terminal'
	| 'timer'
	| 'word'

export type AppTile = {
	index: number
	name: string
	slug: string
	screen: ScreenKind
	marks: ReadonlyArray<MarkId>
	center: Point
	spawnAt: number
	first: boolean
}

/**
 * One of each kind of app, in reveal order: the first ring around the hub
 * gets the most different-looking screens so variety reads immediately.
 */
const catalog: ReadonlyArray<Pick<AppTile, 'name' | 'screen' | 'marks'>> = [
	{ name: 'Support Inbox', screen: 'chat', marks: ['google', 'slack'] },
	{ name: 'Sprint Board', screen: 'kanban', marks: ['linear', 'github'] },
	{ name: 'Focus Playlist', screen: 'player', marks: ['spotify'] },
	{ name: 'Road Trip', screen: 'route', marks: ['google'] },
	{ name: 'Workout Timer', screen: 'timer', marks: ['spotify'] },
	{ name: 'Office Hours', screen: 'booking', marks: ['google'] },
	{ name: 'Daily Word', screen: 'word', marks: [] },
	{ name: 'Home', screen: 'home', marks: ['google'] },
	{ name: 'Family Photos', screen: 'photos', marks: ['google'] },
	{ name: 'Invoice Maker', screen: 'invoice', marks: ['stripe', 'google'] },
	{ name: 'PR Review', screen: 'diff', marks: ['github', 'slack'] },
	{ name: 'Chore Chart', screen: 'chores', marks: ['google'] },
	{ name: 'Spanish Practice', screen: 'flashcards', marks: [] },
	{ name: 'Standup', screen: 'call', marks: ['slack', 'linear'] },
	{ name: 'Sketchpad', screen: 'sketch', marks: [] },
	{ name: 'Budget', screen: 'budget', marks: ['stripe'] },
	{ name: 'Seat Picker', screen: 'seat', marks: ['google'] },
	{ name: 'Lunch Poll', screen: 'poll', marks: ['slack'] },
	{ name: 'Repo Janitor', screen: 'terminal', marks: ['github', 'slack'] },
	{ name: 'Grocery List', screen: 'grocery', marks: ['google'] },
	{ name: 'Newsletter', screen: 'editor', marks: ['google'] },
	{ name: 'Habit Tracker', screen: 'habit', marks: ['google'] },
	{ name: 'Refund Desk', screen: 'approvals', marks: ['stripe', 'slack'] },
	{ name: 'Mood Journal', screen: 'journal', marks: ['google'] },
]

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

/**
 * Walks cells in reveal order and gives each the least-used app, choosing
 * among ties the one whose nearest twin is farthest away, so repeats of the
 * same screen never sit side by side.
 */
function assignApps(centers: ReadonlyArray<Point>) {
	const placed = catalog.map((): Array<Point> => [])
	return centers.map((center) => {
		const fewest = Math.min(...placed.map((cells) => cells.length))
		let best = 0
		let bestGap = -1
		placed.forEach((cells, entry) => {
			if (cells.length !== fewest) return
			const gap = Math.min(
				Infinity,
				...cells.map((cell) =>
					Math.hypot(cell.x - center.x, cell.y - center.y),
				),
			)
			if (gap > bestGap) {
				best = entry
				bestGap = gap
			}
		})
		placed[best]!.push(center)
		return catalog[best]!
	})
}

const revealOrder = cellCenters()
	.map((cell) => ({
		...cell,
		center: { x: cell.column * pitch.x, y: cell.row * pitch.y },
		first: cell.column === firstAppCell.column && cell.row === firstAppCell.row,
	}))
	.filter((cell) => !cell.first)
	.map((cell) => ({ ...cell, visible: visibleFrom(cell.center) }))
	.sort((a, b) => a.visible - b.visible)

const assignedApps = assignApps(revealOrder.map((cell) => cell.center))

export const appTiles: ReadonlyArray<AppTile> = revealOrder.map(
	(cell, index) => {
		const entry = assignedApps[index]!
		return {
			...entry,
			index,
			slug: slugify(entry.name),
			center: cell.center,
			spawnAt: Math.max(cues.zoomOut.start + 3, cell.visible + (index % 3)),
			first: false,
		}
	},
)

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
