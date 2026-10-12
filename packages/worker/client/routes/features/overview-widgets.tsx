import { type Handle, on, type RemixNode } from 'remix/component'
import {
	appPrompts,
	appsScene,
	type AppPromptId,
	integrationAccounts,
	integrationsScene,
	type IntegrationAccountId,
	memoryAgents,
	memoryScene,
	type MemoryAgentId,
	packageChanges,
	packagesScene,
	PrimitiveWidgetFrame,
	secretHosts,
	secretsScene,
	type SecretHostId,
	triggerSources,
	triggersScene,
	type TriggerSourceId,
} from '#client/primitive-widgets.tsx'
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

function SecretsWidget(handle: Handle) {
	let host: SecretHostId = 'approved'
	let shot = 0
	return () => {
		const target = secretHosts.find((entry) => entry.id === host)
		return demo({
			id: 'secrets',
			label: 'Secrets example',
			scene: secretsScene({ host, shot }),
			controls: (
				<>
					<span class="demo-controls-label">Send to</span>
					{secretHosts.map((entry) =>
						controlButton({
							label: entry.host,
							pressed: host === entry.id,
							onPress() {
								host = entry.id
								shot += 1
								handle.update()
							},
						}),
					)}
				</>
			),
			receipt:
				host === 'approved'
					? `Kody attached the key for ${target?.host}. The agent only saw a reference.`
					: `Kody blocked the request. ${target?.host} is not an approved host.`,
		})
	}
}

function PackagesWidget(handle: Handle) {
	let version = 0
	return () =>
		demo({
			id: 'packages',
			label: 'Packages example',
			scene: packagesScene({ version }),
			controls: controlButton({
				label: 'Publish a change',
				onPress() {
					version += 1
					handle.update()
				},
			}),
			receipt:
				version > 0
					? `Published weekly-brief v1.${version + 2} with ${packageChanges[(version - 1) % packageChanges.length]}.`
					: 'weekly-brief is saved code any connected agent can run.',
		})
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
	let account: IntegrationAccountId = 'work'
	let shot = 0
	return () => {
		const entry = integrationAccounts.find((item) => item.id === account)
		return demo({
			id: 'integrations',
			label: 'Integrations example',
			scene: integrationsScene({
				account,
				shot,
				onAccount(id) {
					account = id
					shot += 1
					handle.update()
				},
			}),
			receipt: `weekly-brief → ${entry?.use} through ${entry?.name}.`,
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
			case 'secrets':
				return <SecretsWidget />
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
