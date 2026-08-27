import { type Handle, ref } from 'remix/ui'
import { stageParallax } from '#client/hero-stage.tsx'
import {
	landingLantern,
	landingOrbitAgents,
	landingOrbitTetherPath,
} from '#universal/landing-agent-orbit.ts'
import { heroBaseImage } from '#universal/landing-images.ts'
import {
	listAllWalkthroughHosts,
	walkthroughHostMarkPaint,
	type WalkthroughHost,
	type WalkthroughHostMarkPaint,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'

/**
 * Hero stage: Kody holds the lantern while the agents you already use float
 * around as logo tokens, each tethered to the lantern by a bézier. Balls of
 * lantern light run both ways on independent clocks (driven by the same
 * frame loop that keeps the tethers attached; motion-only), so several are
 * in flight at once and the overlaps keep shifting — inbound reads as the
 * agents feeding the account, outbound as Kody answering back.
 *
 * Tethers sit in front of Kody so every line and light visibly arrives at
 * the lantern instead of vanishing behind his body; a radial mask centred on
 * the globe dissolves them into its glow rather than drawing across it.
 * Replaces the old hub-and-spoke chip arc and the separate "Meet Kody" stage.
 *
 * Coordinates are percentages of the square stage; the SVG line layer shares
 * the 0–100 viewBox so SSR draws the tethers at rest, and `tetherFollow`
 * keeps them pinned once tokens and Kody start moving. Orbit positions live
 * in `#universal/landing-agent-orbit` so OG cards can compose the same still.
 */

/** Slot motion. Identities come from the SSR-shuffled catalog: pinned hosts
 *  always make the ring, leftover slots fill from the rest, then allRow
 *  order assigns them so hydrate matches. `dur`/`del` drive the drift.
 *  `cycle`/`phase`/`travel` (seconds at rate 1) drive each tether's lights:
 *  inbound and outbound share the cycle, outbound offset by ~0.42 of it,
 *  in flight for `travel`. The frame loop advances that clock slower at
 *  rest and faster as the pointer (desktop) or lantern (mobile) nears.
 *  Periods are deliberately unequal so the lights overlap in ever-changing
 *  combinations. Order matches `landingOrbitAgents`. */
const hostAgentMotion = [
	{ dur: '8s', del: '-2s', cycle: 3.4, phase: 0.8, travel: 1.45 },
	{ dur: '8.5s', del: '-1.5s', cycle: 4.8, phase: 2.6, travel: 1.9 },
	{ dur: '6s', del: '-1s', cycle: 3.8, phase: 2.0, travel: 1.25 },
	{ dur: '7.5s', del: '-6s', cycle: 5.6, phase: 0.4, travel: 2.4 },
	{ dur: '9s', del: '-4s', cycle: 3.2, phase: 1.4, travel: 1.55 },
	{ dur: '6.5s', del: '-5s', cycle: 5.9, phase: 4.0, travel: 1.8 },
	{ dur: '5.5s', del: '-2.5s', cycle: 4.2, phase: 1.8, travel: 1.3 },
	{ dur: '9.5s', del: '-3.5s', cycle: 5.1, phase: 3.4, travel: 2.2 },
] as const

export const landingHeroSlots = landingOrbitAgents.map((agent, index) => ({
	x: agent.x,
	y: agent.y,
	...hostAgentMotion[index]!,
}))

/** Always on the homepage ring. Everyone else competes for leftover slots. */
export const landingHeroPinnedHostIds = [
	'grok-bot',
	'chatgpt',
	'claude-code',
] as const

export type LandingHeroAgent = (typeof landingHeroSlots)[number] & {
	label: string
	icon: string
	paint: WalkthroughHostMarkPaint
}

export function pickLandingHeroRing(
	allRow: ReadonlyArray<WalkthroughHost>,
	slotCount: number = landingHeroSlots.length,
): Array<WalkthroughHost> {
	const order = allRow.length > 0 ? allRow : listAllWalkthroughHosts()
	const pinnedIds = new Set<string>(landingHeroPinnedHostIds)
	const pinned = order.filter((host) => pinnedIds.has(host.id))
	const rest = order.filter((host) => !pinnedIds.has(host.id))
	const selectedIds = new Set(
		[...pinned, ...rest].slice(0, slotCount).map((host) => host.id),
	)
	return order.filter((host) => selectedIds.has(host.id))
}

export function placeLandingHeroAgents(
	hosts?: WalkthroughHostPick | null,
): Array<LandingHeroAgent> {
	const identities = pickLandingHeroRing(
		hosts?.allRow ?? listAllWalkthroughHosts(),
	)
	const fallback = listAllWalkthroughHosts()
	return landingHeroSlots.map((slot, index) => {
		const identity = identities[index] ?? fallback[index]!
		return {
			...slot,
			label: identity.label,
			icon: identity.icon,
			paint: walkthroughHostMarkPaint(identity),
		}
	})
}

const lantern = landingLantern

export type LandingHeroLightDirection = 'in' | 'out'

/** Where along its trip a light is, and how it looks. Inbound leaves the
 *  token slowly and is pulled in faster, shrinking as it nears the lantern.
 *  Outbound is the reverse: small at the lantern, growing toward the token.
 *  Fades in leaving and out arriving. `null` while it rests. */
export function landingHeroLightAt(
	agent: Pick<LandingHeroAgent, 'cycle' | 'phase' | 'travel'>,
	seconds: number,
	direction: LandingHeroLightDirection = 'in',
) {
	const phase =
		direction === 'out' ? agent.phase + agent.cycle * 0.42 : agent.phase
	const t = (((seconds + phase) % agent.cycle) + agent.cycle) % agent.cycle
	const linear = t / agent.travel
	if (linear >= 1) return null
	// Ease-in along the trip: gentle departure, quickening approach.
	const eased = linear * linear * (1.7 - 0.7 * linear)
	const progress = direction === 'out' ? 1 - eased : eased
	const fadeIn = Math.min(1, linear / 0.1)
	const fadeOut = Math.min(1, (1 - linear) / 0.14)
	const scale = direction === 'out' ? 0.45 + 0.55 * eased : 1 - 0.55 * eased
	return { progress, opacity: Math.min(fadeIn, fadeOut), scale }
}

/** Wall-clock multiplier for the light clock. `proximity` is 0 far, 1 close. */
export const landingHeroLightRateFar = 0.54
export const landingHeroLightRateNear = 2.31

export function landingHeroLightRate(proximity: number) {
	const t = Math.min(1, Math.max(0, proximity))
	const ease = t * t * (3 - 2 * t)
	return (
		landingHeroLightRateFar +
		(landingHeroLightRateNear - landingHeroLightRateFar) * ease
	)
}

/** How close the controlling point is to the lantern, 0–1. Fine pointers
 *  use the mouse; coarse pointers use the viewport centre (scroll). */
export function landingHeroLightProximity(input: {
	lantern: { x: number; y: number }
	pointer: { x: number; y: number } | null
	viewport: { width: number; height: number }
	finePointer: boolean
}) {
	const range = Math.hypot(input.viewport.width, input.viewport.height) * 0.38
	if (range <= 0) return 0
	const target = input.finePointer
		? input.pointer
		: {
				x: input.viewport.width / 2,
				y: input.viewport.height / 2,
			}
	if (!target) return 0
	const distance = Math.hypot(
		target.x - input.lantern.x,
		target.y - input.lantern.y,
	)
	return 1 - Math.min(1, distance / range)
}

/** Tokens sit deeper in the parallax field than Kody (-0.06) so they float
 *  in front of the backdrop. */
const tokenDepth = '0.32'

const tetherPath = landingOrbitTetherPath

/** Keep every tether pinned to its token and to the lantern while both move
 *  (drift, pointer parallax), and move each light along its tether. Positions
 *  are read from layout each frame and written back as viewBox units, so the
 *  SVG itself never transforms. Runs only while the stage is on screen; under
 *  reduced motion nothing moves and lights stay hidden, so a single pass
 *  after layout (and on resize) is enough. */
function tetherFollow(agents: ReadonlyArray<LandingHeroAgent>) {
	return ref((node: Element, signal: AbortSignal) => {
		const kody = node.querySelector<HTMLElement>('.landing-hero-agents-kody')
		const lines = node.querySelector<SVGSVGElement>(
			'.landing-hero-agents-lines',
		)
		const tiles = [
			...node.querySelectorAll<HTMLElement>('.landing-hero-agent-tile'),
		]
		const tethers = [
			...node.querySelectorAll<SVGGElement>('.landing-hero-agent-tether'),
		]
		if (!kody || !lines || tiles.length === 0) return

		let clock = 0
		let lastNow = performance.now()
		let pointer: { x: number; y: number } | null = null
		const finePointer = matchMedia('(hover: hover) and (pointer: fine)')

		const draw = () => {
			const now = performance.now()
			const dt = Math.min(0.05, (now - lastNow) / 1000)
			lastNow = now
			const stage = node.getBoundingClientRect()
			if (stage.width === 0) return
			const toUnits = (px: number, py: number) => ({
				x: ((px - stage.left) / stage.width) * 100,
				y: ((py - stage.top) / stage.height) * 100,
			})
			const kodyRect = kody.getBoundingClientRect()
			const lanternPx = {
				x: kodyRect.left + (kodyRect.width * lantern.x) / 100,
				y: kodyRect.top + (kodyRect.height * lantern.y) / 100,
			}
			clock +=
				dt *
				landingHeroLightRate(
					landingHeroLightProximity({
						lantern: lanternPx,
						pointer,
						viewport: {
							width: window.innerWidth,
							height: window.innerHeight,
						},
						finePointer: finePointer.matches,
					}),
				)
			const seconds = clock
			const end = toUnits(lanternPx.x, lanternPx.y)
			// The stage is square, so viewBox units double as percentages.
			lines.style.setProperty('--lantern-x', `${end.x}%`)
			lines.style.setProperty('--lantern-y', `${end.y}%`)
			const starts = tiles.map((tile) => {
				const rect = tile.getBoundingClientRect()
				return toUnits(rect.left + rect.width / 2, rect.top + rect.height / 2)
			})
			for (const tether of tethers) {
				const index = Number(tether.dataset.agent)
				const start = starts[index]
				const agent = agents[index]
				if (!start || !agent) continue
				const d = tetherPath(start.x, start.y, end.x, end.y)
				for (const path of tether.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
				const line = tether.querySelector<SVGPathElement>(
					'.landing-hero-agent-line',
				)
				const lights = tether.querySelectorAll<SVGGElement>(
					'g.landing-hero-agent-light',
				)
				if (!line || lights.length === 0) continue
				const length = line.getTotalLength()
				for (const light of lights) {
					const direction = light.dataset.direction === 'out' ? 'out' : 'in'
					const at = landingHeroLightAt(agent, seconds, direction)
					if (!at) {
						light.setAttribute('opacity', '0')
						continue
					}
					const point = line.getPointAtLength(at.progress * length)
					light.setAttribute(
						'transform',
						`translate(${point.x} ${point.y}) scale(${at.scale})`,
					)
					light.setAttribute('opacity', String(at.opacity))
				}
			}
		}

		const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
		let raf: number | null = null
		let visible = false
		const tick = () => {
			raf = null
			draw()
			if (visible && motionOk.matches) raf = requestAnimationFrame(tick)
		}
		const wake = () => {
			lastNow = performance.now()
			if (raf == null) raf = requestAnimationFrame(tick)
		}

		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false
			wake()
		})
		observer.observe(node)
		window.addEventListener(
			'pointermove',
			(event) => {
				if (!(event instanceof PointerEvent)) return
				pointer = { x: event.clientX, y: event.clientY }
			},
			{ signal, passive: true },
		)
		window.addEventListener('resize', wake, { signal })
		motionOk.addEventListener('change', wake, { signal })
		finePointer.addEventListener('change', wake, { signal })
		wake()
		signal.addEventListener('abort', () => {
			observer.disconnect()
			if (raf != null) cancelAnimationFrame(raf)
		})
	})
}

/** The SVG of every tether, drawn over Kody. Lights start hidden;
 *  `tetherFollow` places them. */
function renderTetherLayer(agents: ReadonlyArray<LandingHeroAgent>) {
	return (
		<svg
			class="landing-hero-agents-lines"
			viewBox="0 0 100 100"
			aria-hidden="true"
			style={{
				'--lantern-x': `${lantern.x}%`,
				'--lantern-y': `${lantern.y}%`,
			}}
		>
			<g class="landing-hero-agents-tethers">
				{agents.map((agent, index) => {
					const d = tetherPath(agent.x, agent.y, lantern.x, lantern.y)
					return (
						<g
							key={agent.label}
							class="landing-hero-agent-tether"
							data-agent={String(index)}
						>
							<path class="landing-hero-agent-glow" d={d} fill="none" />
							<path class="landing-hero-agent-line" d={d} fill="none" />
							<g
								class="landing-hero-agent-light"
								data-direction="in"
								opacity="0"
							>
								<circle class="landing-hero-agent-light-halo" r="2.4" />
								<circle class="landing-hero-agent-light-core" r="0.85" />
							</g>
							<g
								class="landing-hero-agent-light"
								data-direction="out"
								opacity="0"
							>
								<circle class="landing-hero-agent-light-halo" r="2.4" />
								<circle class="landing-hero-agent-light-core" r="0.85" />
							</g>
						</g>
					)
				})}
			</g>
		</svg>
	)
}

export function LandingHeroAgents(
	handle: Handle<{ hosts?: WalkthroughHostPick }>,
) {
	return () => {
		const agents = placeLandingHeroAgents(handle.props.hosts)
		return (
			<figure
				data-rise
				style={{ '--rise': '1.2' }}
				class="landing-hero-art landing-hero-agents"
			>
				<figcaption class="visually-hidden">
					Kody the koala holding a warmly glowing lantern, with the agents it
					plugs into floating around it, each connected to Kody.
				</figcaption>
				<div
					class="landing-hero-agents-stage"
					mix={[stageParallax(), tetherFollow(agents)]}
				>
					<img
						src={heroBaseImage.src}
						srcSet={heroBaseImage.srcSet}
						sizes={heroBaseImage.sizes}
						width={heroBaseImage.width}
						height={heroBaseImage.height}
						fetchPriority="high"
						decoding="async"
						data-depth="-0.06"
						alt=""
						class="landing-hero-agents-kody"
					/>
					<div
						class="landing-hero-agents-glow"
						style={{ left: `${lantern.x}%`, top: `${lantern.y}%` }}
						data-depth="-0.06"
					></div>
					{renderTetherLayer(agents)}
					<ul
						aria-label="Agents Kody plugs into"
						class="landing-hero-agents-list"
					>
						{agents.map((agent) => (
							<li
								key={agent.label}
								class="landing-hero-agent"
								data-depth={tokenDepth}
								style={{
									'--x': `${agent.x}%`,
									'--y': `${agent.y}%`,
									'--dur': agent.dur,
									'--del': agent.del,
								}}
							>
								<span
									class="landing-hero-agent-tile"
									data-mark={agent.paint}
									style={{
										'--chip-icon': `url("/images/icons/${agent.icon}.svg")`,
									}}
									aria-hidden="true"
								></span>
								<span class="landing-hero-agent-name">{agent.label}</span>
							</li>
						))}
					</ul>
				</div>
				<p class="landing-hero-agents-mcp">
					Kody works with any agent that supports MCP
				</p>
			</figure>
		)
	}
}
