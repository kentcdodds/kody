import { type Handle, on, type RemixNode } from 'remix/component'
import { primitiveWidgetMotion } from '#client/primitive-widget-motion.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * One small animated scene per primitive, shared by the `/features` cards
 * (`size="full"`, with controls) and the homepage cards (`size="mini"`,
 * decorative). Scenes are plain markup on a 360×200 stage: nodes sit at
 * percentages, wires live in one SVG with the same viewBox, and the type
 * scales with the stage width (`cqw`), so a mini scene is the same picture
 * drawn smaller. Every loop is CSS in `public/primitive-widgets.css`, gated
 * by `data-motion` from `primitiveWidgetMotion`. Without it the scene is a
 * finished still, which is also the reduced-motion and no-JS view.
 *
 * A scene draws `<button>`s only when it gets a pick handler, so the mini
 * copy has nothing to focus.
 */

export type PrimitiveWidgetSize = 'full' | 'mini'

export function PrimitiveWidgetFrame(
	handle: Handle<{
		id: LandingPrimitiveId
		size: PrimitiveWidgetSize
		children?: RemixNode
	}>,
) {
	const motion = primitiveWidgetMotion()
	return () => {
		const { id, size, children } = handle.props
		return (
			<div
				class={`pw pw-${id}`}
				data-size={size}
				aria-hidden={size === 'mini' ? 'true' : undefined}
				style={{ '--pw-accent': `var(--primitive-${id})` }}
				mix={motion}
			>
				<div class="pw-stage">{children}</div>
			</div>
		)
	}
}

function at(x: number, y: number, extra?: Record<string, string>) {
	return { left: `${x}%`, top: `${y}%`, ...extra }
}

function icon(name: string) {
	return (
		<span
			class="pw-icon"
			aria-hidden="true"
			style={{ '--pw-icon': `url("/images/icons/${name}.svg")` }}
		></span>
	)
}

function wires(children: RemixNode) {
	return (
		<svg
			class="pw-wires"
			viewBox="0 0 360 200"
			aria-hidden="true"
			focusable={false}
		>
			{children}
		</svg>
	)
}

/** One wire: the resting line, the looping pulse, and a one-shot pulse
 *  keyed by `shot` so a click replays it. */
function wire(options: {
	d: string
	i?: number
	on?: boolean
	shot?: number
	key?: string
}) {
	const { d, i = 0, on: lit = false, shot = 0, key } = options
	return (
		<g
			key={key}
			class="pw-wire"
			data-on={lit ? '' : undefined}
			style={{ '--i': String(i) }}
		>
			<path class="pw-line" d={d} />
			<path class="pw-pulse" d={d} pathLength="100" />
			{shot > 0 ? (
				<path key={`shot-${shot}`} class="pw-shot" d={d} pathLength="100" />
			) : null}
		</g>
	)
}

function choice(options: {
	class: string
	selected: boolean
	onPick?: () => void
	style?: Record<string, string>
	label?: string
	children: RemixNode
}) {
	const { class: className, selected, onPick, style, label, children } = options
	if (!onPick) {
		return (
			<span class={className} data-on={selected ? '' : undefined} style={style}>
				{children}
			</span>
		)
	}
	return (
		<button
			type="button"
			class={className}
			aria-pressed={selected ? 'true' : 'false'}
			aria-label={label}
			style={style}
			mix={on('click', onPick)}
		>
			{children}
		</button>
	)
}

// Memory: one saved preference, recalled by whichever agent asks.

export const memoryAgents = [
	{ id: 'claude', name: 'Claude', x: 20 },
	{ id: 'cursor', name: 'Cursor', x: 50 },
	{ id: 'chatgpt', name: 'ChatGPT', x: 80 },
] as const

export type MemoryAgentId = (typeof memoryAgents)[number]['id']

export function memoryScene(state: {
	agent: MemoryAgentId
	shot?: number
	onAgent?: (id: MemoryAgentId) => void
}) {
	const { agent, shot = 0, onAgent } = state
	return (
		<>
			{wires(
				memoryAgents.map((entry, i) => {
					const x = (entry.x / 100) * 360
					return wire({
						key: entry.id,
						d: `M180 70 C180 108 ${x} 104 ${x} 142`,
						i,
						on: agent === entry.id,
						shot: agent === entry.id ? shot : 0,
					})
				}),
			)}
			<div class="pw-node pw-note" style={at(50, 21)}>
				<span class="pw-kicker">✎ Writing preference</span>
				<strong>Lead with the decision.</strong>
			</div>
			{memoryAgents.map((entry, i) =>
				choice({
					class: 'pw-node pw-agent',
					selected: agent === entry.id,
					onPick: onAgent ? () => onAgent(entry.id) : undefined,
					label: onAgent ? `Ask ${entry.name}` : undefined,
					style: at(entry.x, 80, { '--i': String(i) }),
					children: (
						<>
							{icon(entry.id)}
							{entry.name}
						</>
					),
				}),
			)}
		</>
	)
}

// Secrets: the agent sends a reference; Kody attaches the key only for an
// approved host.

export const secretHosts = [
	{ id: 'approved', host: 'api.stripe.com', label: 'Approved host' },
	{ id: 'other', host: 'paste.example', label: 'Unknown host' },
] as const

export type SecretHostId = (typeof secretHosts)[number]['id']

export function secretsScene(state: { host: SecretHostId; shot?: number }) {
	const { host, shot = 0 } = state
	const blocked = host === 'other'
	const target = secretHosts.find((entry) => entry.id === host)
	return (
		<div
			class="pw-run"
			key={`run-${shot}`}
			data-blocked={blocked ? '' : undefined}
		>
			{wires(
				<>
					{wire({ d: 'M70 62 L160 62', on: true })}
					{wire({ d: 'M200 62 L276 62', on: !blocked })}
				</>,
			)}
			<div class="pw-lane" style={{ left: '13%', width: '37%', top: '31%' }}>
				<span class="pw-packet">secret:stripe</span>
			</div>
			<div
				class="pw-lane pw-lane-2"
				style={{ left: '50%', width: '36%', top: '31%' }}
			>
				<span class="pw-packet pw-packet-key">sk_••••</span>
			</div>
			<div class="pw-node pw-agent" style={at(13, 31)}>
				{icon('claude')}
				Agent
			</div>
			<div class="pw-node pw-vault" style={at(50, 31)}>
				<span class="pw-lock" aria-hidden="true"></span>
				Kody
			</div>
			<div class="pw-node pw-host" style={at(86, 31)}>
				<span class="pw-host-name">{target?.host}</span>
				<span class="pw-host-status">
					{blocked ? 'Not approved' : '200 OK'}
				</span>
			</div>
			<span class="pw-stamp" style={at(68, 31)} aria-hidden="true">
				✕
			</span>
			<div class="pw-node pw-ledger" style={at(50, 76)}>
				<span>Agent sees</span>
				<code>secret:stripe</code>
				<span>Host receives</span>
				<code>{blocked ? 'Nothing' : 'sk_live_••••••••'}</code>
			</div>
		</div>
	)
}

// Packages: code the agent wrote, sealed into a versioned package.

const packageLines = [
	['export async function ', 'brief', '() {'],
	['  const days = ', 'calendar', '.week()'],
	['  return days.', 'map', '(summarize)'],
	['}', '', ''],
] as const

export const packageChanges = [
	'days.sort(byPriority)',
	'days.filter(isWorkday)',
	'days.slice(0, 5)',
] as const

export function packagesScene(state: { version: number }) {
	const { version } = state
	const change =
		version > 0 ? packageChanges[(version - 1) % packageChanges.length] : null
	const lines = change
		? [
				packageLines[0],
				packageLines[1],
				['  ', change, ''] as const,
				packageLines[2],
				packageLines[3],
			]
		: packageLines
	return (
		<div class="pw-run" key={`v${version}`}>
			{wires(wire({ d: 'M240 80 L272 80', on: true }))}
			<div class="pw-node pw-editor" style={at(4, 50)}>
				<span class="pw-kicker">◇ weekly-brief / src/brief.ts</span>
				<code class="pw-code">
					{lines.map(([lead, word, tail], i) => (
						<span
							key={`${i}-${word}`}
							class="pw-code-line"
							data-diff={change && word === change ? '' : undefined}
							style={{ '--i': String(i) }}
						>
							{lead}
							<b>{word}</b>
							{tail}
						</span>
					))}
				</code>
			</div>
			<div class="pw-box-wrap" style={at(84, 46)}>
				<span class="pw-box" aria-hidden="true">
					<span class="pw-box-lid"></span>
				</span>
				<span class="pw-box-name">weekly-brief</span>
				<span class="pw-badge">Published v1.{version + 2}</span>
			</div>
		</div>
	)
}

// Triggers: a webhook, a schedule, or an email wakes the same package.

export const triggerSources = [
	{ id: 'webhook', name: 'Webhook', glyph: '↗', y: 22 },
	{ id: 'schedule', name: 'Schedule', glyph: '', y: 50 },
	{ id: 'email', name: 'Email', glyph: '✉', y: 78 },
] as const

export type TriggerSourceId = (typeof triggerSources)[number]['id']

export function triggersScene(state: {
	runs: number
	fired?: TriggerSourceId | null
	shot?: number
	onFire?: (id: TriggerSourceId) => void
}) {
	const { runs, fired = null, shot = 0, onFire } = state
	return (
		<>
			{wires(
				triggerSources.map((source, i) => {
					const y = (source.y / 100) * 200
					return wire({
						key: source.id,
						d: `M112 ${y} C162 ${y} 160 100 214 100`,
						i,
						on: fired === source.id,
						shot: fired === source.id ? shot : 0,
					})
				}),
			)}
			{triggerSources.map((source, i) =>
				choice({
					class: 'pw-node pw-source',
					selected: fired === source.id,
					onPick: onFire ? () => onFire(source.id) : undefined,
					label: onFire
						? `Fire ${source.name.toLowerCase()} trigger`
						: undefined,
					style: at(17, source.y, { '--i': String(i) }),
					children: (
						<>
							{source.id === 'schedule' ? (
								<span class="pw-clock" aria-hidden="true"></span>
							) : (
								<span class="pw-glyph" aria-hidden="true">
									{source.glyph}
								</span>
							)}
							{source.name}
						</>
					),
				}),
			)}
			<div class="pw-node pw-fn" style={at(76, 50)}>
				<span class="pw-fn-mark" aria-hidden="true">
					ƒ
				</span>
				<span>
					<strong>purchase-thanks</strong>
					<span class="pw-kicker pw-count" key={`runs-${runs}`}>
						{runs} runs today
					</span>
				</span>
			</div>
		</>
	)
}

// Integrations: one package, routed through Kody to the connection you pick.

export const integrationAccounts = [
	{ id: 'work', name: 'google-work', mark: 'G', y: 24, use: 'Work calendar' },
	{
		id: 'personal',
		name: 'google-personal',
		mark: 'G',
		y: 50,
		use: 'Personal calendar',
	},
	{ id: 'github', name: 'github', mark: '', y: 76, use: 'GitHub issues' },
] as const

export type IntegrationAccountId = (typeof integrationAccounts)[number]['id']

export function integrationsScene(state: {
	account: IntegrationAccountId
	shot?: number
	onAccount?: (id: IntegrationAccountId) => void
}) {
	const { account, shot = 0, onAccount } = state
	return (
		<>
			{wires(
				<>
					{wire({ d: 'M98 100 L140 100', on: true, shot })}
					{integrationAccounts.map((entry) => {
						const y = (entry.y / 100) * 200
						return wire({
							key: entry.id,
							d: `M184 100 C208 100 206 ${y} 232 ${y}`,
							on: account === entry.id,
							shot: account === entry.id ? shot : 0,
						})
					})}
				</>,
			)}
			<div class="pw-node pw-pkg" style={at(15, 50)}>
				<span class="pw-glyph" aria-hidden="true">
					◇
				</span>
				weekly-brief
			</div>
			<div class="pw-hub" style={at(45, 50)}>
				Kody
			</div>
			{integrationAccounts.map((entry) =>
				choice({
					class: 'pw-node pw-conn',
					selected: account === entry.id,
					onPick: onAccount ? () => onAccount(entry.id) : undefined,
					label: onAccount ? `Use ${entry.name}` : undefined,
					style: at(81, entry.y),
					children: (
						<>
							{entry.mark ? (
								<span class="pw-mark" aria-hidden="true">
									{entry.mark}
								</span>
							) : (
								icon('github')
							)}
							{entry.name}
						</>
					),
				}),
			)}
		</>
	)
}

// Apps: a prompt turns into a small hosted app.

export const appPrompts = [
	{
		id: 'intake',
		label: 'Project intake',
		prompt: 'Make me a project intake form',
		slug: 'project-intake',
		fields: ['Project name', 'Due date'],
		values: ['Autumn launch', 'Nov 14'],
		action: 'Save brief',
	},
	{
		id: 'reading',
		label: 'Reading list',
		prompt: 'Build a page to track my reading',
		slug: 'reading-list',
		fields: ['Title', 'Author'],
		values: ['The Overstory', 'R. Powers'],
		action: 'Add book',
	},
	{
		id: 'habits',
		label: 'Habit tracker',
		prompt: 'I want a tiny habit tracker',
		slug: 'habits',
		fields: ['Habit', 'Streak'],
		values: ['Morning walk', '12 days'],
		action: 'Check in',
	},
] as const

export type AppPromptId = (typeof appPrompts)[number]['id']

export function appsScene(state: { prompt: AppPromptId; shot?: number }) {
	const app =
		appPrompts.find((entry) => entry.id === state.prompt) ?? appPrompts[0]
	return (
		<div class="pw-run" key={`${app.id}-${state.shot ?? 0}`}>
			<div class="pw-node pw-prompt" style={at(4, 6)}>
				<span class="pw-prompt-text">› {app.prompt}</span>
			</div>
			<div class="pw-node pw-window" style={at(25, 31)}>
				<span class="pw-chrome">
					<span aria-hidden="true">● ● ●</span> {app.slug}
				</span>
				<strong class="pw-app-title">{app.label}</strong>
				{app.fields.map((field, i) => (
					<span key={field} class="pw-field" style={{ '--i': String(i) }}>
						<span>{field}</span>
						<span class="pw-input">{app.values[i]}</span>
					</span>
				))}
				<span class="pw-app-action">{app.action}</span>
				<span class="pw-toast">Saved ✓</span>
			</div>
			<span class="pw-cursor" aria-hidden="true"></span>
		</div>
	)
}

/** Each scene at rest, for the homepage cards. */
export function primitiveRestScene(id: LandingPrimitiveId): RemixNode {
	switch (id) {
		case 'memory':
			return memoryScene({ agent: 'cursor' })
		case 'secrets':
			return secretsScene({ host: 'approved' })
		case 'packages':
			return packagesScene({ version: 0 })
		case 'triggers':
			return triggersScene({ runs: 12 })
		case 'integrations':
			return integrationsScene({ account: 'work' })
		case 'apps':
			return appsScene({ prompt: 'intake' })
		default: {
			const unknown: never = id
			throw new Error(`Unknown primitive: ${String(unknown)}`)
		}
	}
}
