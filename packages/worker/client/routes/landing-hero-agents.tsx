import { type Handle, ref } from 'remix/ui'
import { stageParallax } from '#client/hero-stage.tsx'
import { heroBaseImage } from '#universal/landing-images.ts'

/**
 * Hero stage: Kody holds the lantern while the agents you already use float
 * around as logo tokens, each tethered to Kody by a bézier. Light pulses run
 * down the tethers on independent clocks (CSS only, enhance-only), so several
 * are in flight at once and the overlaps keep shifting — it reads as all of
 * them in use, landing on the same account. Replaces the old hub-and-spoke chip arc
 * and the separate "Meet Kody" stage.
 *
 * Coordinates are percentages of the square stage; the SVG line layer shares
 * the 0–100 viewBox so SSR draws the tethers at rest, and `tetherFollow`
 * keeps them pinned once tokens and Kody start moving.
 */

/** `dur`/`del` drive the drift; `cycle`/`phase` drive each tether's pulse
 *  clock — periods are deliberately unequal so pulses overlap in
 *  ever-changing combinations. */
const hostAgents = [
	{
		label: 'Cursor',
		icon: 'cursor',
		x: 12,
		y: 19,
		dur: '8s',
		del: '-2s',
		cycle: '7.3s',
		phase: '-1.1s',
	},
	{
		label: 'Claude Code',
		icon: 'claudecode',
		x: 88,
		y: 19,
		dur: '8.5s',
		del: '-1.5s',
		cycle: '9.1s',
		phase: '-6.4s',
	},
	{
		label: 'ChatGPT',
		icon: 'chatgpt',
		x: 93,
		y: 46,
		dur: '6s',
		del: '-1s',
		cycle: '8.2s',
		phase: '-3.7s',
	},
	{
		label: 'Copilot',
		icon: 'githubcopilot',
		x: 87,
		y: 72,
		dur: '7.5s',
		del: '-6s',
		cycle: '10.6s',
		phase: '-0.6s',
	},
	{
		label: 'Claude',
		icon: 'claude',
		x: 74,
		y: 92,
		dur: '9s',
		del: '-4s',
		cycle: '6.7s',
		phase: '-4.9s',
	},
	{
		label: 'Grok',
		icon: 'grok',
		x: 26,
		y: 92,
		dur: '6.5s',
		del: '-5s',
		cycle: '11.3s',
		phase: '-8.2s',
	},
	{
		label: 'Grok Bot',
		icon: 'grokbot',
		x: 13,
		y: 72,
		dur: '5.5s',
		del: '-2.5s',
		cycle: '7.9s',
		phase: '-2.3s',
	},
	{
		label: 'OpenCode',
		icon: 'opencode',
		x: 7,
		y: 46,
		dur: '9.5s',
		del: '-3.5s',
		cycle: '9.7s',
		phase: '-5.5s',
	},
] as const

/** Where the tethers meet, as a fraction of the Kody image: behind the chest,
 *  just above the lantern, so they visibly run into Kody. */
const hub = { x: 50, y: 62 }

/** Tokens sit deeper in the parallax field than Kody (-0.06) so they float
 *  in front of the backdrop. */
const tokenDepth = '0.32'

/** Cubic bézier from a token to the hub: leaves the token roughly downward,
 *  then sweeps into Kody, so the fan reads as drawn rather than ruled. */
function tetherPath(x: number, y: number, hx: number, hy: number) {
	const dx = hx - x
	const dy = hy - y
	const c1x = x + dx * 0.08
	const c1y = y + dy * 0.55
	const c2x = hx - dx * 0.38
	const c2y = hy - dy * 0.08
	return `M${x} ${y} C${c1x} ${c1y} ${c2x} ${c2y} ${hx} ${hy}`
}

/** Keep every tether pinned to its token and to Kody while both move (drift,
 *  spotlight scale, pointer parallax). Positions are read from layout each
 *  frame and written back as viewBox units, so the SVG itself never
 *  transforms. Runs only while the stage is on screen; under reduced motion
 *  nothing moves, so a single pass after layout (and on resize) is enough. */
function tetherFollow() {
	return ref((node: Element, signal: AbortSignal) => {
		const kody = node.querySelector<HTMLElement>('.landing-hero-agents-kody')
		const tiles = [
			...node.querySelectorAll<HTMLElement>('.landing-hero-agent-tile'),
		]
		const tethers = [
			...node.querySelectorAll<SVGGElement>('.landing-hero-agent-tether'),
		]
		if (!kody || tiles.length === 0 || tiles.length !== tethers.length) return

		const draw = () => {
			const stage = node.getBoundingClientRect()
			if (stage.width === 0) return
			const toUnits = (px: number, py: number) => ({
				x: ((px - stage.left) / stage.width) * 100,
				y: ((py - stage.top) / stage.height) * 100,
			})
			const kodyRect = kody.getBoundingClientRect()
			const end = toUnits(
				kodyRect.left + (kodyRect.width * hub.x) / 100,
				kodyRect.top + (kodyRect.height * hub.y) / 100,
			)
			tethers.forEach((tether, index) => {
				const tile = tiles[index]
				if (!tile) return
				const rect = tile.getBoundingClientRect()
				const start = toUnits(
					rect.left + rect.width / 2,
					rect.top + rect.height / 2,
				)
				const d = tetherPath(start.x, start.y, end.x, end.y)
				for (const path of tether.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
			})
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
				<svg
					class="landing-hero-agents-lines"
					viewBox="0 0 100 100"
					aria-hidden="true"
				>
					{hostAgents.map((agent) => {
						const d = tetherPath(agent.x, agent.y, hub.x, hub.y)
						return (
							<g
								key={agent.label}
								class="landing-hero-agent-tether"
								style={{ '--cycle': agent.cycle, '--phase': agent.phase }}
							>
								<path
									class="landing-hero-agent-line"
									d={d}
									pathLength="1"
									fill="none"
								/>
								<path
									class="landing-hero-agent-pulse"
									d={d}
									pathLength="1"
									fill="none"
								/>
							</g>
						)
					})}
				</svg>
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
