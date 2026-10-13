import { type Handle, on } from 'remix/component'
import {
	at,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '#client/primitive-widget-parts.tsx'

/**
 * `/features/integrations` scenes. Account and package buttons sit outside
 * the keyed `.pw-run` so a replay does not drop focus. The run only holds
 * the wires, the hub, and the packets.
 */

export type IntegrationAccountId = 'personal' | 'work'
export type IntegrationEventId = 'first' | 'second'
export type IntegrationPackageId = 'brief' | 'prep' | 'planner'

const accounts = {
	personal: {
		name: 'google-personal',
		label: 'Personal',
		email: 'alex@personal.example',
		events: [
			{ id: 'first', text: '10:00 · Dentist appointment' },
			{ id: 'second', text: '18:30 · Dinner with Sam' },
		],
	},
	work: {
		name: 'google-work',
		label: 'Work',
		email: 'alex@company.example',
		events: [
			{ id: 'first', text: '09:00 · Project review' },
			{ id: 'second', text: '14:00 · Client check-in' },
		],
	},
} as const satisfies Record<
	IntegrationAccountId,
	{
		name: string
		label: string
		email: string
		events: ReadonlyArray<{ id: IntegrationEventId; text: string }>
	}
>

const packages = {
	brief: {
		name: 'weekly-brief',
		operation: "Read this week's calendar events",
		title: 'Your week, ready to review.',
		copy: "Monday's project review and Thursday's client check-in, collected in one brief.",
		request: 'read week',
		result: 'brief',
	},
	prep: {
		name: 'meeting-prep',
		operation: 'Read the next meeting',
		title: 'Walk in prepared.',
		copy: 'Project review, Monday at 09:00. Bring the launch brief and your open questions.',
		request: 'read meeting',
		result: 'meeting prep notes',
	},
	planner: {
		name: 'day-planner',
		operation: "Read today's calendar",
		title: 'Make room for focused work.',
		copy: 'Your next meeting starts at 14:00. Keep the morning open for the launch page.',
		request: 'read today',
		result: 'day plan',
	},
} as const satisfies Record<
	IntegrationPackageId,
	{
		name: string
		operation: string
		title: string
		copy: string
		request: string
		result: string
	}
>

const packageOrder = [
	'brief',
	'prep',
	'planner',
] as const satisfies ReadonlyArray<IntegrationPackageId>

/** ViewBox y of each package button. The fan wires and lanes share these. */
const packageRowY = {
	brief: 64,
	prep: 102,
	planner: 136,
} as const satisfies Record<IntegrationPackageId, number>

const heroHeight = 232
const reuseHeight = 308
const setupHeight = 300

function accountInfo(id: IntegrationAccountId) {
	switch (id) {
		case 'personal':
			return accounts.personal
		case 'work':
			return accounts.work
		default: {
			const unknown: never = id
			return unknown
		}
	}
}

function packageInfo(id: IntegrationPackageId) {
	switch (id) {
		case 'brief':
			return packages.brief
		case 'prep':
			return packages.prep
		case 'planner':
			return packages.planner
		default: {
			const unknown: never = id
			return unknown
		}
	}
}

function eventName(text: string) {
	return text.split(' · ')[1] ?? text
}

/** Short enough to travel the gap between Kody and the package. */
function packetEventName(text: string) {
	switch (text) {
		case '09:00 · Project review':
			return 'Review'
		case '14:00 · Client check-in':
			return 'Check-in'
		case '10:00 · Dentist appointment':
			return 'Dentist'
		case '18:30 · Dinner with Sam':
			return 'Dinner'
		default:
			return eventName(text)
	}
}

export function integrationAccountStatus(
	account: IntegrationAccountId,
	event: IntegrationEventId | null,
) {
	const info = accountInfo(account)
	const events = info.events.map((entry) => entry.text).join(' and ')
	const picked = info.events.find((entry) => entry.id === event)
	const received = `Requested upcoming events from ${info.name} through Kody. weekly-brief received ${events} for ${info.email}.`
	if (!picked) return received
	return `${received} ${picked.text} is in the brief.`
}

function lane(
	className: string,
	box: { left: string; width: string; top: string },
	label: string,
) {
	return (
		<div class={`pw-int-lane ${className}`} style={box}>
			<span class="pw-packet">{label}</span>
		</div>
	)
}

export function IntegrationsHeroScene(
	handle: Handle<{
		account: IntegrationAccountId
		event: IntegrationEventId | null
		shot: number
		onAccount: (account: IntegrationAccountId) => void
		onEvent: (event: IntegrationEventId) => void
	}>,
) {
	return () => {
		const { account, event, shot, onAccount, onEvent } = handle.props
		const info = accountInfo(account)
		const picked = info.events.find((entry) => entry.id === event)
		const backLabel = picked ? packetEventName(picked.text) : '2 events'
		return (
			<PrimitiveWidgetFrame
				id="integrations"
				size="full"
				height={heroHeight}
				class="pw-scene-int-hero"
			>
				<div class="pw-run" key={`${account}-${event ?? 'none'}-${shot}`}>
					{wires(
						<>
							{wire({
								key: 'out',
								d: 'M146 88 H232',
								on: true,
							})}
							{wire({
								key: 'back',
								d: 'M232 144 H146',
								on: true,
							})}
						</>,
						heroHeight,
					)}
					{lane(
						'pw-int-out to-east',
						{ left: '44%', width: '18%', top: '38%' },
						'events?',
					)}
					{lane(
						'pw-int-back to-west',
						{ left: '44%', width: '18%', top: '62%' },
						backLabel,
					)}
					<div class="pw-hub pw-int-hero-hub" style={at(53, 50)}>
						Kody
					</div>
				</div>
				<div class="pw-node pw-int-brief">
					<span class="pw-int-kicker">weekly-brief · Read upcoming events</span>
					<strong class="pw-int-email">{info.email}</strong>
					<div class="pw-int-events">
						{info.events.map((entry) => (
							<button
								key={entry.id}
								type="button"
								class="pw-int-hit pw-int-event"
								aria-pressed={event === entry.id}
								mix={on('click', () => onEvent(entry.id))}
							>
								{entry.text}
								{event === entry.id ? (
									<span class="pw-int-check" aria-hidden="true">
										✓
									</span>
								) : null}
							</button>
						))}
					</div>
					<span class="pw-int-stamp" aria-hidden="true">
						{picked ? 'In the brief' : 'Returned'}
					</span>
				</div>
				<div
					class="pw-node pw-int-google"
					role="group"
					aria-labelledby="int-account-label"
				>
					<span class="pw-int-google-head">
						<span class="pw-mark">G</span>
						<strong id="int-account-label">Google</strong>
						<span class="pw-int-count">2 accounts</span>
					</span>
					{(['personal', 'work'] as const).map((id) => {
						const row = accountInfo(id)
						return (
							<button
								key={id}
								type="button"
								class="pw-int-hit pw-int-account"
								aria-pressed={account === id}
								mix={on('click', () => onAccount(id))}
							>
								<strong>{row.name}</strong>
								<small>{row.label}</small>
							</button>
						)
					})}
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export function IntegrationsReuseScene(
	handle: Handle<{
		selected: IntegrationPackageId
		shot: number
		onSelect: (id: IntegrationPackageId) => void
	}>,
) {
	return () => {
		const { selected, shot, onSelect } = handle.props
		const info = packageInfo(selected)
		const rowY = packageRowY[selected]
		return (
			<PrimitiveWidgetFrame
				id="integrations"
				size="full"
				height={reuseHeight}
				class="pw-scene-int-reuse"
			>
				<div class="pw-run" key={`${selected}-${shot}`}>
					{wires(
						packageOrder.flatMap((id) => {
							const y = packageRowY[id]
							const onWire = id === selected
							if (!onWire) {
								return [wire({ key: `${id}-idle`, d: `M238 ${y} H118` })]
							}
							return [
								wire({
									key: `${id}-out`,
									d: `M238 ${y - 7} H118`,
									on: onWire,
								}),
								wire({
									key: `${id}-back`,
									d: `M118 ${y + 7} H238`,
									on: onWire,
								}),
							]
						}),
						reuseHeight,
					)}
					{lane(
						'pw-int-out to-west',
						{
							left: '34%',
							width: '32%',
							top: `${((rowY - 7) / reuseHeight) * 100}%`,
						},
						info.request,
					)}
					{lane(
						'pw-int-back to-east',
						{
							left: '34%',
							width: '32%',
							top: `${((rowY + 7) / reuseHeight) * 100}%`,
						},
						info.result,
					)}
					<div class="pw-int-bus">Kody</div>
				</div>
				<div class="pw-node pw-int-saved">
					<span class="pw-int-saved-head">
						<span class="pw-mark" aria-hidden="true">
							G
						</span>
						<strong>google-work</strong>
					</span>
					<small class="pw-int-saved-email">{accounts.work.email}</small>
					<span class="pw-int-pill">Saved connection</span>
				</div>
				<fieldset class="pw-int-picker">
					<legend class="visually-hidden">
						Choose the example package using google-work
					</legend>
					{packageOrder.map((id) => {
						const row = packageInfo(id)
						const y = packageRowY[id]
						return (
							<button
								key={id}
								type="button"
								class="pw-int-hit pw-int-pack"
								style={{ top: `${(y / reuseHeight) * 100}%` }}
								aria-pressed={selected === id}
								mix={on('click', () => onSelect(id))}
							>
								{row.name}
							</button>
						)
					})}
				</fieldset>
				<div class="pw-node pw-int-result" aria-live="polite">
					<small id="ia-operation">{info.operation}</small>
					<h3 id="ia-output-title">{info.title}</h3>
					<p id="ia-output-copy">{info.copy}</p>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

const setupSteps = [
	{
		title: 'Choose the service.',
		detail: 'Google',
	},
	{
		title: 'Finish sign-in.',
		detail: accounts.work.email,
	},
	{
		title: 'Test a small request.',
		detail: '09:00 · Project review',
	},
] as const

export function IntegrationsSetupScene(_handle: Handle) {
	return () => {
		return (
			<PrimitiveWidgetFrame
				id="integrations"
				size="full"
				height={setupHeight}
				class="pw-scene-int-setup"
			>
				<div class="pw-run" key="setup">
					<div class="pw-int-board">
						<ol class="pw-int-steps">
							{setupSteps.map((step, index) => (
								<li key={step.title} class="pw-int-step">
									<span class="pw-int-num" aria-hidden="true">
										{index + 1}
									</span>
									<span class="pw-int-step-copy">
										<strong>{step.title}</strong>
										<small>{step.detail}</small>
									</span>
									<span class="pw-int-check" aria-hidden="true">
										✓
									</span>
								</li>
							))}
						</ol>
						<div class="pw-int-test">
							<span class="pw-int-chip">list 1 event</span>
							<div class="pw-int-lane pw-int-out to-east">
								<span class="pw-packet">list 1 event</span>
							</div>
							<div class="pw-hub pw-int-hub">Kody</div>
							<div class="pw-int-lane pw-int-back to-west">
								<span class="pw-packet">Project review</span>
							</div>
							<span class="pw-int-chip pw-int-chip-account">
								<span class="pw-mark" aria-hidden="true">
									G
								</span>
								<span>
									<strong>google-work</strong>
									<small>09:00 · Project review</small>
								</span>
							</span>
						</div>
						<div class="pw-int-lock">
							<div class="pw-int-lock-head">
								<span class="pw-mark" aria-hidden="true">
									G
								</span>
								<strong>google-work</strong>
								<span class="pw-int-pill">
									<span class="pw-int-padlock" aria-hidden="true"></span>
									Specific packages
								</span>
							</div>
							<div class="pw-int-gate-row" data-gate="deny">
								<span class="pw-int-id">mail-send</span>
								<span class="pw-packet">send</span>
								<span class="pw-int-verdict">
									<span aria-hidden="true">✕ </span>Refused
								</span>
							</div>
							<div class="pw-int-gate-row" data-gate="allow">
								<span class="pw-int-id">gmail-drafts</span>
								<span class="pw-packet">create draft</span>
								<span class="pw-int-verdict">
									<span aria-hidden="true">✓ </span>Passed
								</span>
							</div>
							<div class="pw-int-grant">
								<span>Allowed package</span>
								<code>gmail-drafts</code>
							</div>
							<div class="pw-int-grant pw-int-behavior">
								<span>Published behavior</span>
								<strong>Create a draft for review</strong>
							</div>
						</div>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}
