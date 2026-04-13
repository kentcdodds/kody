import path from 'node:path'
import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type VenstarDiscoveryDiagnostics } from '../src/adapters/venstar/types.ts'
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

function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2)
}

function renderCodeBlock(value: string) {
	return html`<pre><code>${value}</code></pre>`
}

function renderBanner(input: { tone: 'success' | 'error'; message: string }) {
	return html`<section
		class="card ${input.tone === 'error' ? 'card-error' : 'card-success'}"
	>
		<p>${input.message}</p>
	</section>`
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

function renderDiscoveredThermostatList(
	thermostats: ReturnType<
		ReturnType<typeof createVenstarAdapter>['getStatus']
	>['discovered'],
) {
	if (thermostats.length === 0) {
		return html`<p class="muted">
			No new Venstar thermostats were discovered in the last scan.
		</p>`
	}
	return html`<ul class="list">
		${thermostats.map(
			(thermostat) => html`<li class="card">
				<strong>${thermostat.name}</strong>
				<div>IP: <code>${thermostat.ip}</code></div>
				<div>Location: <code>${thermostat.location}</code></div>
				<div>Last seen: ${thermostat.lastSeenAt}</div>
				<div class="muted">
					Copy this name/IP into <code>VENSTAR_THERMOSTATS</code> or
					<code>venstar-thermostats.json</code>.
				</div>
			</li>`,
		)}
	</ul>`
}

function renderVenstarDiscoveryDiagnostics(
	diagnostics: VenstarDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">No Venstar scan diagnostics captured yet.</p>`
	}
	return html`
		<section class="card">
			<h2>Discovery diagnostics</h2>
			${renderInfoRows([
				{ label: 'Protocol', value: diagnostics.protocol },
				{
					label: 'Discovery URL',
					value: html`<code>${diagnostics.discoveryUrl}</code>`,
				},
				{ label: 'Last scan', value: diagnostics.scannedAt },
				{ label: 'SSDP hits', value: diagnostics.ssdpHits.length },
				{ label: 'Info lookups', value: diagnostics.infoLookups.length },
			])}
		</section>
		${diagnostics.jsonResponse
			? html`<section class="card">
					<h2>Raw discovery payload</h2>
					${renderCodeBlock(formatJson(diagnostics.jsonResponse))}
				</section>`
			: ''}
		<section class="card">
			<h2>SSDP hits</h2>
			${diagnostics.ssdpHits.length === 0
				? html`<p class="muted">No SSDP hits were captured.</p>`
				: html`<ul class="list">
						${diagnostics.ssdpHits.map(
							(hit) => html`<li class="card">
								<div>
									From:
									<code>${hit.remoteAddress}:${String(hit.remotePort)}</code>
								</div>
								<div>Location: <code>${hit.location ?? 'missing'}</code></div>
								<div>USN: <code>${hit.usn ?? 'missing'}</code></div>
								<div>Server: <code>${hit.server ?? 'missing'}</code></div>
								${renderCodeBlock(hit.raw)}
							</li>`,
						)}
					</ul>`}
		</section>
		<section class="card">
			<h2>Info lookups</h2>
			${diagnostics.infoLookups.length === 0
				? html`<p class="muted">No thermostat info lookups were captured.</p>`
				: html`<ul class="list">
						${diagnostics.infoLookups.map(
							(lookup) => html`<li class="card">
								<div>Location: <code>${lookup.location}</code></div>
								<div>Info URL: <code>${lookup.infoUrl}</code></div>
								<div>Error: ${lookup.error ?? 'none'}</div>
								${lookup.parsed
									? html`<div>
											Parsed:
											<code>${formatJson(lookup.parsed)}</code>
										</div>`
									: ''}
								${lookup.raw ? renderCodeBlock(formatJson(lookup.raw)) : ''}
							</li>`,
						)}
					</ul>`}
		</section>
	`
}

function renderVenstarStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createVenstarAdapter>['getStatus']>
	thermostats: Awaited<
		ReturnType<
			ReturnType<typeof createVenstarAdapter>['listThermostatsWithStatus']
		>
	>
	scanMessage?: string | null
	scanError?: string | null
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
					<form method="POST">
						<button type="submit">Scan now</button>
					</form>
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
						<div>
							<strong>Discovered thermostats</strong>
							<div>${input.status.discovered.length}</div>
						</div>
					</div>
				</section>
				${input.scanMessage
					? renderBanner({ tone: 'success', message: input.scanMessage })
					: ''}
				${input.scanError
					? renderBanner({ tone: 'error', message: input.scanError })
					: ''}
				<section class="card">
					<h2>Configured thermostats</h2>
					${renderThermostatList(input.thermostats)}
				</section>
				<section class="card">
					<h2>Discovered thermostats</h2>
					<p class="muted">
						Discovery helps you find thermostat names and IPs to copy into the
						static Venstar config.
					</p>
					${renderDiscoveredThermostatList(input.status.discovered)}
				</section>
				${renderVenstarDiscoveryDiagnostics(input.status.diagnostics)}`,
		}),
	)
}

export function createVenstarStatusHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const discovered = await venstar.scan()
					return renderVenstarStatusPage({
						state,
						status: venstar.getStatus(),
						thermostats: await venstar.listThermostatsWithStatus(),
						scanMessage: `Scan complete. Discovered ${discovered.length} Venstar thermostat(s).`,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/venstar/status',
							action: 'scan',
						},
						contexts: {
							venstar: {
								discoveryUrl: config.venstarDiscoveryUrl,
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderVenstarStatusPage({
						state,
						status: venstar.getStatus(),
						thermostats: await venstar.listThermostatsWithStatus(),
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}
			return renderVenstarStatusPage({
				state,
				status: venstar.getStatus(),
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
			const status = venstar.getStatus()
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
									label: 'Discovery URL',
									value: html`<code>${config.venstarDiscoveryUrl}</code>`,
								},
								{
									label: 'Discovered thermostats',
									value: String(status.discovered.length),
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
							${status.discovered.length === 0
								? ''
								: html`<p class="muted">
										A recent scan also found ${status.discovered.length}
										unconfigured thermostat(s) on the LAN.
									</p>`}
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
