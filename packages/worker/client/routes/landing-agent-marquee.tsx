import { type Handle } from 'remix/component'
import {
	resolveWithAgentOrder,
	withAgentHref,
	withAgentIconSrc,
	type WithAgent,
} from '#universal/with-agents.ts'

/**
 * Homepage hero row of agent marks, each linking to its `/with/:agent` page.
 * The order is shuffled once on the server (`landingAgentOrder` loader data)
 * so hydrate matches. With JavaScript and motion allowed, a second
 * aria-hidden copy of the list makes the CSS loop seamless; otherwise the
 * row is a plain horizontal scroller. Styles: `.landing-agents` in
 * `public/styles.css`.
 */
export function LandingAgentMarquee(
	handle: Handle<{ order?: ReadonlyArray<string> | null }>,
) {
	return () => {
		const agents = resolveWithAgentOrder(handle.props.order)
		return (
			<nav class="landing-agents" aria-label="Agents that work with Kody">
				<ul class="landing-agents-track">
					{agents.map((agent) => renderAgent(agent, false))}
					{agents.map((agent) => renderAgent(agent, true))}
				</ul>
			</nav>
		)
	}
}

function renderAgent(agent: WithAgent, loopCopy: boolean) {
	return (
		<li
			key={loopCopy ? `${agent.slug}-loop` : agent.slug}
			class="landing-agents-item"
			aria-hidden={loopCopy ? 'true' : undefined}
		>
			<a
				href={withAgentHref(agent.slug)}
				class="landing-agent"
				tabIndex={loopCopy ? -1 : undefined}
			>
				<span
					class="landing-agent-icon"
					aria-hidden="true"
					style={{ '--agent-icon': `url(${withAgentIconSrc(agent)})` }}
				></span>
				<span class="landing-agent-name">{agent.name}</span>
			</a>
		</li>
	)
}
