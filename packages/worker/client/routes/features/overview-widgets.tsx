import { type Handle, on, type RemixNode } from 'remix/component'
import {
	appPrompts,
	appsScene,
	type AppPromptId,
	integrationSlots,
	integrationsScene,
	type IntegrationSlotId,
	memoryAgents,
	memoryScene,
	type MemoryAgentId,
	packageCallers,
	packageChanges,
	packagesScene,
	type PackageCallerId,
	triggerSources,
	triggersScene,
	type TriggerSourceId,
} from '#client/primitive-widgets.tsx'
import { PrimitiveWidgetFrame } from '#client/primitive-widget-parts.tsx'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * `/features` cards: the shared primitive scenes plus the controls that
 * drive them. Every control is a real button with a pressed state, and the
 * receipt under each scene is a polite live region that says what changed.
 */

function demo(options: {
	id: LandingPrimitiveId
	label: string
	scene: RemixNode
	controls?: RemixNode
	receipt: string
}) {
	return (
		<div class="demo" role="group" aria-label={options.label}>
			<PrimitiveWidgetFrame id={options.id} size="full">
				{options.scene}
			</PrimitiveWidgetFrame>
			{options.controls ? (
				<div class="demo-controls">{options.controls}</div>
			) : null}
			<p class="receipt" aria-live="polite">
				{options.receipt}
			</p>
		</div>
	)
}

function controlButton(options: {
	label: string
	pressed?: boolean
	onPress: () => void
}) {
	return (
		<button
			type="button"
			class="demo-control"
			aria-pressed={
				options.pressed === undefined
					? undefined
					: options.pressed
						? 'true'
						: 'false'
			}
			mix={on('click', options.onPress)}
		>
			{options.label}
		</button>
	)
}

function MemoryWidget(handle: Handle) {
	let agent: MemoryAgentId = 'cursor'
	let shot = 0
	return () => {
		const name = memoryAgents.find((entry) => entry.id === agent)?.name
		return demo({
			id: 'memory',
			label: 'Memory example',
			scene: memoryScene({
				agent,
				shot,
				onAgent(id) {
					agent = id
					shot += 1
					handle.update()
				},
			}),
			receipt:
				shot > 0
					? `${name} found your writing preference.`
					: 'Pick an agent. Each one finds the same saved preference.',
		})
	}
}

function PackagesWidget(handle: Handle) {
	let version = 0
	let caller: PackageCallerId = 'claude'
	let invoked = 0
	return () => {
		const name = packageCallers.find((entry) => entry.id === caller)?.name
		const release = `v1.${version + 2}`
		return demo({
			id: 'packages',
			label: 'Packages example',
			scene: packagesScene({
				version,
				caller,
				invoked,
				onCaller(id) {
					caller = id
					invoked += 1
					handle.update()
				},
			}),
			controls: controlButton({
				label: 'Publish a change',
				onPress() {
					version += 1
					invoked = 0
					handle.update()
				},
			}),
			receipt:
				invoked > 0
					? `${name} invoked weekly-brief ${release} and got this week's brief back.`
					: version > 0
						? `Published weekly-brief ${release} with ${packageChanges[(version - 1) % packageChanges.length]}. Pick an agent to invoke it.`
						: 'Write it once as a package. Then pick an agent to invoke it.',
		})
	}
}

function TriggersWidget(handle: Handle) {
	let runs = 12
	let fired: TriggerSourceId | null = null
	let shot = 0
	return () => {
		const source = triggerSources.find((entry) => entry.id === fired)
		return demo({
			id: 'triggers',
			label: 'Triggers example',
			scene: triggersScene({
				runs,
				fired,
				shot,
				onFire(id) {
					fired = id
					runs += 1
					shot += 1
					handle.update()
				},
			}),
			receipt: source
				? `${source.name} woke purchase-thanks. Run ${runs} finished without a chat open.`
				: 'Fire a trigger to wake the package.',
		})
	}
}

function IntegrationsWidget(handle: Handle) {
	let booked: IntegrationSlotId | null = null
	let shot = 0
	return () => {
		const slot = integrationSlots.find((entry) => entry.id === booked)
		return demo({
			id: 'integrations',
			label: 'Credentials example',
			scene: integrationsScene({
				booked,
				shot,
				onBook(id) {
					booked = id
					shot += 1
					handle.update()
				},
			}),
			controls: controlButton({
				label: 'Ask for times again',
				onPress() {
					booked = null
					shot += 1
					handle.update()
				},
			}),
			receipt: slot
				? `Booked ${slot.label} on google-work. The request went out through Kody and the confirmation came back.`
				: 'meet-finder asked google-work for open times through Kody. Pick one to book it.',
		})
	}
}

function AppsWidget(handle: Handle) {
	let prompt: AppPromptId = 'intake'
	let shot = 0
	return () => {
		const app = appPrompts.find((entry) => entry.id === prompt)
		return demo({
			id: 'apps',
			label: 'Apps example',
			scene: appsScene({ prompt, shot }),
			controls: (
				<>
					<span class="demo-controls-label">Ask for</span>
					{appPrompts.map((entry) =>
						controlButton({
							label: entry.label,
							pressed: prompt === entry.id,
							onPress() {
								prompt = entry.id
								shot += 1
								handle.update()
							},
						}),
					)}
				</>
			),
			receipt:
				shot > 0
					? `Your agent turned “${app?.prompt}” into the ${app?.label} app.`
					: 'A prompt becomes an app you can open and share.',
		})
	}
}

export function OverviewWidget(handle: Handle<{ id: LandingPrimitiveId }>) {
	return () => {
		const { id } = handle.props
		switch (id) {
			case 'memory':
				return <MemoryWidget />
			case 'packages':
				return <PackagesWidget />
			case 'triggers':
				return <TriggersWidget />
			case 'integrations':
				return <IntegrationsWidget />
			case 'apps':
				return <AppsWidget />
			default: {
				const unknown: never = id
				throw new Error(`Unknown primitive: ${String(unknown)}`)
			}
		}
	}
}
