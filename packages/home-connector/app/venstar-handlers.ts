import path from 'node:path'
import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { type routes } from './routes.ts'

function renderInfoRows(
	rows: Array<{
		label: string
		value: string | number | ReturnType<typeof html>
	}>,
) {
	return html`<div class="info-list">
		${rows.map(
			(row) =>
				html`<div class="info-row">
					<div class="info-label">${row.label}</div>
					<div class="info-value">${row.value}</div>
				</div>`,
		)}
	</div>`
}

function renderThermostatList(
	thermostats: Awaited<
		ReturnType<
			ReturnType<typeof createVenstarAdapter>['listThermostatsWithStatus']
		>
	>,
) {
	if (thermostats.length === 0) {
		return html`<p class="muted">
			No Venstar thermostats are configured yet. Add one in
			<code>VENSTAR_THERMOSTATS</code>
			or
			<code>venstar-thermostats.json</code>.
		</p>`
	}

	return html`<ul class="list">
		${thermostats.map((thermostat) => {
			const summary = thermostat.summary
			return html`<li class="card">
				<strong>${thermostat.name}</strong>
				<div>IP: <code>${thermostat.ip}</code></div>
				<div>Status: ${'status' in summary ? 'offline' : 'online'}</div>
				${'status' in summary
					? html`<div>Error: ${summary.message}</div>`
					: html`
							<div>Space temp: ${summary.spacetemp}</div>
							<div>Humidity: ${summary.humidity}</div>
							<div>Mode: ${summary.mode}</div>
							<div>State: ${summary.state}</div>
							<div>Fan: ${summary.fan}</div>
							<div>Heat setpoint: ${summary.heattemp}</div>
							<div>Cool setpoint: ${summary.cooltemp}</div>
							<div>Schedule: ${summary.schedule}</div>
							<div>Away: ${summary.away}</div>
							<div>Units: ${summary.units}</div>
						`}
			</li>`
		})}
	</ul>`
}

function renderVenstarStatusPage(input: {
	state: HomeConnectorState
	thermostats: Awaited<
		ReturnType<
			ReturnType<typeof createVenstarAdapter>['listThermostatsWithStatus']
		>
	>
}) {
	const onlineCount = input.thermostats.filter(
		(thermostat) => thermostat.info != null,
	).length
	return render(
		RootLayout({
			title: 'home connector - venstar status',
			body: html`<section class="card">
					<h1>Venstar status</h1>
					<p class="muted">
						Live connectivity and temperature state for the configured Venstar
						thermostats on this connector.
					</p>
					<p>
						<a href="/venstar/setup">Venstar setup</a>
						<span class="muted"> — review the local configuration inputs</span>
					</p>
					<div class="status-grid">
						<div>
							<strong>Worker connection</strong>
							<div>
								${input.state.connection.connected
									? 'connected'
									: 'disconnected'}
							</div>
						</div>
						<div>
							<strong>Configured thermostats</strong>
							<div>${input.thermostats.length}</div>
						</div>
						<div>
							<strong>Online thermostats</strong>
							<div>${onlineCount}</div>
						</div>
						<div>
							<strong>Offline thermostats</strong>
							<div>${input.thermostats.length - onlineCount}</div>
						</div>
					</div>
				</section>
				<section class="card">
					<h2>Thermostats</h2>
					${renderThermostatList(input.thermostats)}
				</section>`,
		}),
	)
}

export function createVenstarStatusHandler(
	state: HomeConnectorState,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	return {
		middleware: [],
		async action() {
			return renderVenstarStatusPage({
				state,
				thermostats: await venstar.listThermostatsWithStatus(),
			})
		},
	} satisfies BuildAction<
		typeof routes.venstarStatus.method,
		typeof routes.venstarStatus.pattern
	>
}

export function createVenstarSetupHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	return {
		middleware: [],
		async action() {
			const thermostats = venstar.listThermostats()
			const configFilePath = path.join(
				config.dataPath,
				'venstar-thermostats.json',
			)
			return render(
				RootLayout({
					title: 'home connector - venstar setup',
					body: html`<section class="card">
							<h1>Venstar setup</h1>
							<p class="muted">
								Configure Venstar thermostats with a static IP address and turn
								on the thermostat&apos;s local API before using control tools.
							</p>
							<p>
								<a href="/venstar/status">Venstar status</a>
								<span class="muted">
									— verify connectivity after you save config
								</span>
							</p>
							${renderInfoRows([
								{ label: 'Worker URL', value: config.workerBaseUrl },
								{
									label: 'Connector ID',
									value: state.connection.connectorId || 'not registered yet',
								},
								{
									label: 'Configured thermostats',
									value: String(thermostats.length),
								},
								{
									label: 'Env var',
									value: html`<code>VENSTAR_THERMOSTATS</code>`,
								},
								{
									label: 'Config file',
									value: html`<code>${configFilePath}</code>`,
								},
							])}
						</section>
						<section class="card">
							<h2>Expected JSON</h2>
							<pre><code>[
  {"name":"Hallway","ip":"192.168.1.40"},
  {"name":"Bedroom","ip":"192.168.1.41"}
]</code></pre>
						</section>
						<section class="card">
							<h2>Configured thermostats</h2>
							${thermostats.length === 0
								? html`<p class="muted">
										No Venstar thermostats are configured yet.
									</p>`
								: html`<ul class="list">
										${thermostats.map(
											(thermostat) =>
												html`<li class="card">
													<strong>${thermostat.name}</strong>
													<div>IP: <code>${thermostat.ip}</code></div>
												</li>`,
										)}
									</ul>`}
							<p class="muted">
								Setup stays read-only here because thermostat registration lives
								in the connector env/file config, while live checks happen on
								the Venstar status page.
							</p>
						</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.venstarSetup.method,
		typeof routes.venstarSetup.pattern
	>
}
