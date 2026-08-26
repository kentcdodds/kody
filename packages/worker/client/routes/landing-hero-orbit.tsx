import { type Handle } from 'remix/ui'
import { revealPop } from '#client/reveal.ts'
import {
	heroOrbitArcPath,
	heroOrbitHub,
	heroOrbitPoint,
	heroOrbitSpokePath,
} from './landing-hero-orbit.ts'

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
									mix={revealPop(index * 35)}
								>
									{agent.label}
								</li>
							)
						})}
					</ul>
					<div class="landing-hero-orbit-you" aria-hidden="true">
						<span class="landing-hero-orbit-you-label">You</span>
						<span class="landing-hero-orbit-you-figure">
							<svg
								viewBox="0 0 32 40"
								width="28"
								height="34"
								aria-hidden="true"
							>
								<circle cx="16" cy="7" r="5" fill="currentColor" />
								<path
									fill="currentColor"
									d="M10 14h12c1.2 0 2 .8 2 2v7l-3 1v10h-3.2V26h-3.6v8H11V24l-3-1v-7c0-1.2.8-2 2-2z"
								/>
								<path
									class="landing-hero-orbit-you-stride"
									fill="currentColor"
									d="M9 34h5l2 6H10zm9 0h5l-1 6h-5z"
								/>
							</svg>
						</span>
					</div>
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
