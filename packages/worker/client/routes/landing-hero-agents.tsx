import { type Handle, ref } from 'remix/ui'
import { stageParallax } from '#client/hero-stage.tsx'
import { heroBaseImage } from '#universal/landing-images.ts'

/**
 * Hero stage: Kody holds the lantern while the agents you already use float
 * around as logo tokens, each tethered to the lantern by a bézier. Balls of
 * lantern light run down the tethers on independent clocks (driven by the
 * same frame loop that keeps the tethers attached; motion-only), so several
 * are in flight at once and the overlaps keep shifting — it reads as all of
 * them in use, feeding the same account.
 *
 * Tethers sit in front of Kody so every line and light visibly arrives at
 * the lantern instead of vanishing behind his body; a radial mask centred on
 * the globe dissolves them into its glow rather than drawing across it.
 * Replaces the old hub-and-spoke chip arc and the separate "Meet Kody" stage.
 *
 * Coordinates are percentages of the square stage; the SVG line layer shares
 * the 0–100 viewBox so SSR draws the tethers at rest, and `tetherFollow`
 * keeps them pinned once tokens and Kody start moving.
 */

/** `dur`/`del` drive the drift. `cycle`/`phase`/`travel` (seconds) drive
 *  each tether's light: one light per cycle, in flight for `travel` of it.
 *  Periods and speeds are deliberately unequal so the lights overlap in
 *  ever-changing combinations. */
const hostAgents = [
	{
		label: 'Cursor',
		icon: 'cursor',
		x: 12,
		y: 19,
		dur: '8s',
		del: '-2s',
		cycle: 4.6,
		phase: 1.1,
		travel: 1.9,
	},
	{
		label: 'Claude Code',
		icon: 'claudecode',
		x: 88,
		y: 19,
		dur: '8.5s',
		del: '-1.5s',
		cycle: 6.3,
		phase: 3.4,
		travel: 2.6,
	},
	{
		label: 'ChatGPT',
		icon: 'chatgpt',
		x: 93,
		y: 46,
		dur: '6s',
		del: '-1s',
		cycle: 5.1,
		phase: 2.7,
		travel: 1.6,
	},
	{
		label: 'Copilot',
		icon: 'githubcopilot',
		x: 87,
		y: 72,
		dur: '7.5s',
		del: '-6s',
		cycle: 7.4,
		phase: 0.6,
		travel: 3.2,
	},
	{
		label: 'Claude',
		icon: 'claude',
		x: 74,
		y: 92,
		dur: '9s',
		del: '-4s',
		cycle: 4.2,
		phase: 1.9,
		travel: 2.1,
	},
	{
		label: 'Grok',
		icon: 'grok',
		x: 26,
		y: 92,
		dur: '6.5s',
		del: '-5s',
		cycle: 7.9,
		phase: 5.2,
		travel: 2.4,
	},
	{
		label: 'Grok Bot',
		icon: 'grokbot',
		x: 13,
		y: 72,
		dur: '5.5s',
		del: '-2.5s',
		cycle: 5.7,
		phase: 2.3,
		travel: 1.7,
	},
	{
		label: 'OpenCode',
		icon: 'opencode',
		x: 7,
		y: 46,
		dur: '9.5s',
		del: '-3.5s',
		cycle: 6.8,
		phase: 4.5,
		travel: 2.9,
	},
] as const

/** The lantern globe, as a fraction of the Kody image (measured from the
 *  art: glass spans x 50.7–63.3, y 44.0–54.8): where every tether ends,
 *  every light lands, and the glow sits. */
const lantern = { x: 57, y: 49.4 }

/** Where along its trip a light is, and how it looks: it leaves the token
 *  slowly and is pulled in faster, shrinks as it nears the lantern, fades in
 *  leaving and out arriving. `null` while it rests. */
function lightAt(agent: (typeof hostAgents)[number], seconds: number) {
	const t =
		(((seconds + agent.phase) % agent.cycle) + agent.cycle) % agent.cycle
	const linear = t / agent.travel
	if (linear >= 1) return null
	// Ease-in: gentle departure, quickening approach.
	const progress = linear * linear * (1.7 - 0.7 * linear)
	const fadeIn = Math.min(1, progress / 0.1)
	const fadeOut = Math.min(1, (1 - progress) / 0.14)
	const scale = 1 - 0.55 * progress
	return { progress, opacity: Math.min(fadeIn, fadeOut), scale }
}

/** Tokens sit deeper in the parallax field than Kody (-0.06) so they float
 *  in front of the backdrop. */
const tokenDepth = '0.32'

/** Cubic bézier from a token to the lantern: leaves the token toward Kody's
 *  midline, then arrives at the lantern from the token's side, so the fan
 *  reads as drawn rather than ruled. */
function tetherPath(x: number, y: number, hx: number, hy: number) {
	const dx = hx - x
	const dy = hy - y
	const c1x = x + dx * 0.1
	const c1y = y + dy * 0.6
	const c2x = hx - dx * 0.45
	const c2y = hy - dy * 0.05
	return `M${x} ${y} C${c1x} ${c1y} ${c2x} ${c2y} ${hx} ${hy}`
}

/** Keep every tether pinned to its token and to the lantern while both move
 *  (drift, pointer parallax), and move each light along its tether. Positions
 *  are read from layout each frame and written back as viewBox units, so the
 *  SVG itself never transforms. Runs only while the stage is on screen; under
 *  reduced motion nothing moves and lights stay hidden, so a single pass
 *  after layout (and on resize) is enough. */
function tetherFollow() {
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

		const draw = () => {
			const seconds = performance.now() / 1000
			const stage = node.getBoundingClientRect()
			if (stage.width === 0) return
			const toUnits = (px: number, py: number) => ({
				x: ((px - stage.left) / stage.width) * 100,
				y: ((py - stage.top) / stage.height) * 100,
			})
			const kodyRect = kody.getBoundingClientRect()
			const end = toUnits(
				kodyRect.left + (kodyRect.width * lantern.x) / 100,
				kodyRect.top + (kodyRect.height * lantern.y) / 100,
			)
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
				const agent = hostAgents[index]
				if (!start || !agent) continue
				const d = tetherPath(start.x, start.y, end.x, end.y)
				for (const path of tether.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
				const line = tether.querySelector<SVGPathElement>(
					'.landing-hero-agent-line',
				)
				const light = tether.querySelector<SVGGElement>(
					'g.landing-hero-agent-light',
				)
				if (!line || !light) continue
				const at = lightAt(agent, seconds)
				if (!at) {
					light.setAttribute('opacity', '0')
					continue
				}
				const length = line.getTotalLength()
				const point = line.getPointAtLength(at.progress * length)
				light.setAttribute(
					'transform',
					`translate(${point.x} ${point.y}) scale(${at.scale})`,
				)
				light.setAttribute('opacity', String(at.opacity))
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
			if (raf == null) raf = requestAnimationFrame(tick)
		}

		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false
			wake()
		})
		observer.observe(node)
		window.addEventListener('resize', wake, { signal })
		motionOk.addEventListener('change', wake, { signal })
		wake()
		signal.addEventListener('abort', () => {
			observer.disconnect()
			if (raf != null) cancelAnimationFrame(raf)
		})
	})
}

/** The SVG of every tether, drawn over Kody. Lights start hidden;
 *  `tetherFollow` places them. */
function TetherLayer(_handle: Handle) {
	return () => {
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
					{hostAgents.map((agent, index) => {
						const d = tetherPath(agent.x, agent.y, lantern.x, lantern.y)
						return (
							<g
								key={agent.label}
								class="landing-hero-agent-tether"
								data-agent={String(index)}
							>
								<path class="landing-hero-agent-glow" d={d} fill="none" />
								<path class="landing-hero-agent-line" d={d} fill="none" />
								<g class="landing-hero-agent-light" opacity="0">
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
}

export function LandingHeroAgents(_handle: Handle) {
	return () => (
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
				mix={[stageParallax(), tetherFollow()]}
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
				<TetherLayer />
				<ul
					aria-label="Agents Kody plugs into"
					class="landing-hero-agents-list"
				>
					{hostAgents.map((agent) => (
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
