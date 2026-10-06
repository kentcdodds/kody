import {
	landingLanternGlass,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Leader lines while the 3D lantern is live. The orbs move in depth and
 * turn with the glass, so the words follow them: each word takes the row
 * its orb's height ranks, and the list sits centred on the glass. Every
 * line leaves its orb's right rim in a lane of its own, runs straight out
 * to one shared line past the glass, and curves into its dot from there.
 * The lanes and the rows are in the same order and every curve has the
 * same shape, so no two lines cross. A line that passes behind another orb
 * breaks around it instead of seeming to end there, and a small dot marks
 * where each line meets its own orb. Taking over from the 2D layout, the
 * words keep its list order until the orbs' heights agree with it, so two
 * rows do not trade places on the way in and back again.
 */

type Point = { x: number; y: number }

/** An orb on screen; a higher `order` is nearer. */
export type LeaderOrb = Point & {
	id: LandingPrimitiveId
	radius: number
	order: number
}

/** Two orbs within this many pixels of one height may keep either order,
 *  so a jitter cannot make their words trade places back and forth. */
const rankSlackPx = 6

/** Clearance around another orb that a passing line breaks for. */
const passPadPx = 4

/** Least space between two runs, so orbs side by side never share one. */
const laneGapPx = 8

/** How far up or down its orb a run may leave, as a share of the radius. */
const laneReach = 0.7

/** The leader leaves just inside the painted rim, where its dot sits. */
const rimShare = 0.9

/** The bus sits this far across the lantern box, just past the glass. */
const busShare = 0.99

/** An orb's place in the word order and the height it was sorted by. */
export type LeaderRank = { id: LandingPrimitiveId; key: number }

/**
 * Top to bottom. Each orb sorts by a height that only catches up once the
 * orb has moved half the slack from it, so no pair is ever ranked against
 * a gap wider than the slack, and ties keep the last order.
 */
export function rankLeaderOrbs(
	previous: ReadonlyArray<LeaderRank>,
	orbs: ReadonlyArray<LeaderOrb>,
): Array<LeaderRank> {
	const before = new Map(
		previous.map((rank, index) => [rank.id, { key: rank.key, index }]),
	)
	return orbs
		.map((orb) => {
			const last = before.get(orb.id)
			const held = last && Math.abs(orb.y - last.key) < rankSlackPx / 2
			return {
				id: orb.id,
				key: held ? last.key : orb.y,
				index:
					last?.index ?? previous.length + landingPrimitiveIds.indexOf(orb.id),
			}
		})
		.sort((a, b) => a.key - b.key || a.index - b.index)
		.map(({ id, key }) => ({ id, key }))
}

/**
 * The height each run takes, for orbs in rank order: its orb's own height
 * where there is room, and otherwise eased apart until the runs sit
 * `laneGapPx` apart, moving them as little as possible (pool adjacent
 * violators on height minus rank times the gap). Runs then keep the
 * order of the words even inside the re-rank slack.
 */
export function leaderLanes(ranked: ReadonlyArray<LeaderOrb>): Array<number> {
	const blocks: Array<{ sum: number; count: number }> = []
	for (const [rank, orb] of ranked.entries()) {
		blocks.push({ sum: orb.y - rank * laneGapPx, count: 1 })
		while (blocks.length > 1) {
			const last = blocks.at(-1)!
			const before = blocks.at(-2)!
			if (before.sum / before.count <= last.sum / last.count) break
			before.sum += last.sum
			before.count += last.count
			blocks.pop()
		}
	}
	const lanes: Array<number> = []
	for (const block of blocks) {
		for (let index = 0; index < block.count; index++) {
			lanes.push(block.sum / block.count + lanes.length * laneGapPx)
		}
	}
	return lanes.map((lane, rank) => {
		const orb = ranked[rank]!
		const reach = orb.radius * laneReach
		return Math.min(Math.max(lane, orb.y - reach), orb.y + reach)
	})
}

/**
 * Whether words taking over from the 2D layout keep its list order for
 * another frame, for orbs listed in that order: until the orbs run top to
 * bottom, and only while their runs, in that order, keep at least half the
 * usual gap, so holding it never crosses two lines or runs them together.
 */
export function leaderListOrderHolds(orbs: ReadonlyArray<LeaderOrb>) {
	const agreed = orbs.every(
		(orb, index) => index === 0 || orbs[index - 1]!.y <= orb.y,
	)
	if (agreed) return false
	const lanes = leaderLanes(orbs)
	return lanes.every(
		(lane, rank) => rank === 0 || lane - lanes[rank - 1]! > laneGapPx / 2,
	)
}

/**
 * Stretches of a horizontal run at height `y` from `from` to `to` that no
 * other orb covers.
 */
export function leaderRunSpans(
	y: number,
	from: number,
	to: number,
	others: ReadonlyArray<LeaderOrb>,
): Array<readonly [number, number]> {
	const covered: Array<readonly [number, number]> = []
	for (const orb of others) {
		const reach = orb.radius + passPadPx
		const rise = orb.y - y
		if (Math.abs(rise) >= reach) continue
		const half = Math.sqrt(reach * reach - rise * rise)
		covered.push([orb.x - half, orb.x + half])
	}
	covered.sort((a, b) => a[0] - b[0])
	const spans: Array<readonly [number, number]> = []
	let start = from
	for (const [left, right] of covered) {
		if (right <= start) continue
		if (left >= to) break
		if (left > start) spans.push([start, left])
		start = Math.max(start, right)
	}
	if (start < to) spans.push([start, to])
	return spans
}

/**
 * From the orb's rim, straight out to the bus, then a curve into the dot
 * with level ends. Every curve shares its x control points, which keep x
 * moving one way, so two curves only meet if their ends swap order. The
 * last stretch of the run and the curve are one subpath, so the flowing
 * dashes carry on round the bend.
 */
export function routedLeaderPath(
	from: Point,
	busX: number,
	to: Point,
	others: ReadonlyArray<LeaderOrb>,
) {
	const y = round(from.y)
	const spans = leaderRunSpans(from.y, from.x, busX, others)
	const run = spans
		.map(([left, right]) => `M${round(left)} ${y}H${round(right)}`)
		.join('')
	const reachesBus = (spans.at(-1)?.[1] ?? -Infinity) >= busX
	const reach = Math.max(to.x - busX, 0) * 0.5
	const curve = `C${round(busX + reach)} ${y} ${round(to.x - reach * 0.6)} ${round(to.y)} ${round(to.x)} ${round(to.y)}`
	return reachesBus ? run + curve : `${run}M${round(busX)} ${y}${curve}`
}

/** Where the leader meets its orb: on the rim at its lane, facing the bus. */
export function leaderOrbEnd(orb: LeaderOrb, lane = orb.y): Point {
	const rim = orb.radius * rimShare
	const rise = Math.min(Math.abs(lane - orb.y), rim)
	return { x: orb.x + Math.sqrt(rim * rim - rise * rise), y: lane }
}

/** A nearer orb in front of this one's end, mid-turn. */
export function leaderEndHidden(
	orb: LeaderOrb,
	end: Point,
	others: ReadonlyArray<LeaderOrb>,
) {
	return others.some(
		(other) =>
			other.order > orb.order &&
			Math.hypot(end.x - other.x, end.y - other.y) < other.radius,
	)
}

export type LanternLeaders = {
	/** Measure the orbs, place the words, and write every leader. */
	draw: (stage: DOMRect) => void
	/** Back to the 2D layout: words in place and no end dots. */
	reset: () => void
}

export type CreateLanternLeaders = typeof createLanternLeaders

/**
 * The DOM side: `section` holds the stage, the leader overlay, and the word
 * list. Rows and the list's centre come from layout (`offsetTop`), which a
 * translate does not move, so a word's place never feeds back into itself.
 */
export function createLanternLeaders(
	section: HTMLElement,
	svg: SVGSVGElement,
): LanternLeaders {
	let active = false
	/** Taking over from the 2D layout, whose words run in list order. */
	let handingOff = true
	let order: Array<LeaderRank> = []
	const ends = new Map<LandingPrimitiveId, SVGCircleElement>()
	const shifts = new Map<LandingPrimitiveId, string>()
	let drop = ''

	function endFor(id: LandingPrimitiveId, leader: SVGGElement) {
		const existing = ends.get(id)
		if (existing?.isConnected) return existing
		const end = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
		end.setAttribute('class', 'landing-leader-end')
		end.setAttribute('r', '3.25')
		leader.append(end)
		ends.set(id, end)
		return end
	}

	function setShift(id: LandingPrimitiveId, element: HTMLElement, px: number) {
		const value = `${round(px)}px`
		if (shifts.get(id) === value) return
		shifts.set(id, value)
		element.style.setProperty('--label-shift', value)
	}

	/** The orbs on screen, in word order. */
	function measureOrbs(origin: DOMRect) {
		return landingPrimitiveIds.flatMap((id): Array<LeaderOrb> => {
			const hotspot = section.querySelector<HTMLElement>(
				`.landing-lantern-3d-orb[data-orb="${id}"]`,
			)
			if (!hotspot) return []
			const box = hotspot.getBoundingClientRect()
			return [
				{
					id,
					x: box.left + box.width / 2 - origin.left,
					y: box.top + box.height / 2 - origin.top,
					radius: box.width / 2,
					// The scene stacks nearer hotspots higher.
					order: Number(hotspot.style.zIndex) || 0,
				},
			]
		})
	}

	return {
		draw(origin) {
			const words = section.querySelector<HTMLElement>(
				'.landing-primitives-words',
			)
			const lantern = section.querySelector<HTMLElement>('.landing-lantern')
			if (!words || !lantern) return
			active = true
			section.dataset.leaders = '3d'
			const art = lantern.getBoundingClientRect()
			const glassY = art.top - origin.top + art.height * landingLanternGlass.y
			const listCentre = words.offsetTop + words.offsetHeight / 2
			const nextDrop = `${round(glassY - listCentre)}px`
			if (nextDrop !== drop) {
				drop = nextDrop
				words.style.setProperty('--labels-drop', drop)
			}

			const items = new Map<LandingPrimitiveId, HTMLElement>()
			const rows = new Map<LandingPrimitiveId, number>()
			for (const id of landingPrimitiveIds) {
				const dot = words.querySelector(`[data-dot="${id}"]`)
				const item = dot?.closest<HTMLElement>('.landing-primitive')
				const row = item?.closest<HTMLElement>('.landing-primitive-item')
				if (!item || !row) continue
				items.set(id, item)
				rows.set(id, row.offsetTop + row.offsetHeight / 2)
			}

			const orbs = measureOrbs(origin)
			handingOff &&= leaderListOrderHolds(orbs)
			order = handingOff ? [] : rankLeaderOrbs(order, orbs)
			const ranked = handingOff
				? orbs
				: order.flatMap(({ id }) => orbs.filter((orb) => orb.id === id))
			for (const [rank, { id }] of ranked.entries()) {
				const item = items.get(id)
				const own = rows.get(id)
				const target = rows.get(landingPrimitiveIds[rank]!)
				if (!item || own === undefined || target === undefined) continue
				setShift(id, item, target - own)
			}

			// Past every orb's disc too, so the bend is never broken.
			const lastEnd = Math.max(
				...orbs.map((orb) => orb.x + orb.radius + passPadPx + 1),
			)
			const busX = Math.max(
				art.left - origin.left + art.width * busShare,
				lastEnd,
			)
			const lanes = leaderLanes(ranked)
			for (const [rank, orb] of ranked.entries()) {
				const dot = section.querySelector(`[data-dot="${orb.id}"]`)
				const leader = svg.querySelector<SVGGElement>(
					`[data-primitive="${orb.id}"]`,
				)
				if (!dot || !leader) continue
				const box = dot.getBoundingClientRect()
				const to = {
					x: box.left - origin.left - 2,
					y: box.top + box.height / 2 - origin.top,
				}
				const from = leaderOrbEnd(orb, lanes[rank])
				const others = orbs.filter((other) => other.id !== orb.id)
				const d = routedLeaderPath(from, busX, to, others)
				for (const path of leader.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
				const end = endFor(orb.id, leader)
				end.setAttribute('cx', `${round(from.x)}`)
				end.setAttribute('cy', `${round(from.y)}`)
				end.toggleAttribute('data-hidden', leaderEndHidden(orb, from, others))
			}
		},
		reset() {
			if (!active) return
			active = false
			delete section.dataset.leaders
			handingOff = true
			order = []
			for (const end of ends.values()) end.remove()
			ends.clear()
			for (const item of section.querySelectorAll<HTMLElement>(
				'.landing-primitive',
			)) {
				item.style.removeProperty('--label-shift')
			}
			shifts.clear()
			section
				.querySelector<HTMLElement>('.landing-primitives-words')
				?.style.removeProperty('--labels-drop')
			drop = ''
		},
	}
}

function round(value: number) {
	return Math.round(value * 10) / 10
}
