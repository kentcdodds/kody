import { type Handle } from 'remix/ui'
import {
	heroOrbitArcPath,
	heroOrbitHub,
	heroOrbitPoint,
	heroOrbitSpokePath,
} from './landing-hero-orbit-geometry.ts'

const hostAgents = [
	{ label: 'Cursor', icon: 'cursor' },
	{ label: 'Claude Code', icon: 'claudecode' },
	{ label: 'ChatGPT', icon: 'chatgpt' },
	{ label: 'Copilot', icon: 'githubcopilot' },
	{ label: 'Claude', icon: 'claude' },
	{ label: 'Grok', icon: 'grok' },
	{ label: 'Grok Bot', icon: 'grokbot' },
	{ label: 'OpenCode', icon: 'opencode' },
] as const

function chipIconStyle(icon: string) {
	return { '--chip-icon': `url("/images/icons/${icon}.svg")` }
}

/**
 * Hub-and-spoke hero metaphor: you walk the host-chip arc; every host spoke
 * anchors to the Kody hub (existing mark). Reuses the landing host chips —
 * not a second logo row and not a new koala.
 */
export function LandingHeroOrbit(_handle: Handle) {
	return () => {
		const orbitTotal = hostAgents.length
		const arcPath = heroOrbitArcPath(orbitTotal)

		return (
			<figure data-rise style={{ '--rise': '1.2' }} class="landing-hero-orbit">
				<figcaption class="visually-hidden">
					You move between agents. Each agent connects down to Kody, the account
					that stays put.
				</figcaption>
				<div class="landing-hero-orbit-stage">
					<p class="landing-hero-orbit-agents-label" aria-hidden="true">
						agents
					</p>
					<svg
						class="landing-hero-orbit-canvas"
						viewBox="0 0 100 100"
						aria-hidden="true"
					>
						{hostAgents.map((_, index) => {
							const spoke = heroOrbitSpokePath(index, orbitTotal)
							return (
								<line
									key={`spoke-${index}`}
									class="landing-hero-orbit-spoke"
									x1={spoke.x1}
									y1={spoke.y1}
									x2={spoke.x2}
									y2={spoke.y2}
								/>
							)
						})}
						{/* Soft chain along the arc — agents stay peers, Kody is the hub. */}
						<path class="landing-hero-orbit-arc" d={arcPath} fill="none" />
					</svg>
					<ul
						aria-label="Agents Kody plugs into"
						class="landing-hero-orbit-hosts"
					>
						{hostAgents.map((agent, index) => {
							const point = heroOrbitPoint(index, orbitTotal)
							return (
								<li
									key={agent.label}
									class="landing-chip landing-chip-icon landing-host-chip landing-hero-orbit-host"
									style={{
										...chipIconStyle(agent.icon),
										left: `${point.x}%`,
										top: `${point.y}%`,
									}}
								>
									{agent.label}
								</li>
							)
						})}
					</ul>
					{/* Separate SVG layer so You walks above the chips. */}
					<svg
						class="landing-hero-orbit-you-layer"
						viewBox="0 0 100 100"
						aria-hidden="true"
					>
						<path
							id="landing-hero-you-path"
							d={arcPath}
							fill="none"
							stroke="none"
						/>
						<g class="landing-hero-orbit-you-motion">
							<g transform="translate(0 -8)">
								<text
									class="landing-hero-orbit-you-label-svg"
									text-anchor="middle"
									x="0"
									y="-10"
								>
									You
								</text>
								<g
									class="landing-hero-orbit-you-figure-svg"
									fill="currentColor"
								>
									<circle cx="0" cy="-5.5" r="1.6" />
									<path d="M-2.2-3.2h4.4c.4 0 .7.3.7.7v2.4l-1.1.4v3.6h-1.2v-2.9h-1.2v2.9h-1.2V-.1L-2.9.1v-2.4c0-.4.3-.7.7-.7z" />
								</g>
							</g>
							<animateMotion
								dur="8s"
								repeatCount="indefinite"
								keyPoints="0;1;0"
								keyTimes="0;0.5;1"
								calcMode="linear"
							>
								<mpath href="#landing-hero-you-path" />
							</animateMotion>
						</g>
						<g
							class="landing-hero-orbit-you-static"
							transform={`translate(${heroOrbitPoint(3, orbitTotal).x} ${heroOrbitPoint(3, orbitTotal).y - 8})`}
						>
							<text
								class="landing-hero-orbit-you-label-svg"
								text-anchor="middle"
								x="0"
								y="-10"
							>
								You
							</text>
							<g class="landing-hero-orbit-you-figure-svg" fill="currentColor">
								<circle cx="0" cy="-5.5" r="1.6" />
								<path d="M-2.2-3.2h4.4c.4 0 .7.3.7.7v2.4l-1.1.4v3.6h-1.2v-2.9h-1.2v2.9h-1.2V-.1L-2.9.1v-2.4c0-.4.3-.7.7-.7z" />
							</g>
						</g>
					</svg>
					<div
						class="landing-hero-orbit-hub"
						style={{
							left: `${heroOrbitHub.x}%`,
							top: `${heroOrbitHub.y}%`,
						}}
					>
						<img
							src="/images/kody-mark.png"
							alt=""
							width={28}
							height={28}
							class="landing-hero-orbit-hub-mark"
						/>
						<span class="landing-hero-orbit-hub-name">Kody</span>
					</div>
				</div>
				<p class="landing-hero-orbit-hub-label" aria-hidden="true">
					Kody
				</p>
				<p class="landing-hero-orbit-mcp">anything that speaks MCP</p>
			</figure>
		)
	}
}
