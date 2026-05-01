import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import {
	type VenstarDiscoveryDiagnostics,
	type VenstarManagedThermostat,
} from '../src/adapters/venstar/types.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { type routes } from './routes.ts'
import {
	formatJson,
	renderBanner,
	renderCodeBlock,
	renderInfoRows,
} from './handler-utils.ts'

function requireStringField(
	formData: FormData,
	key: string,
	label: string,
): string {
	const value = formData.get(key)
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${label} is required.`)
	}
	return value.trim()
}

async function readPostedFormData(request: Request, fallbackAction: string) {
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
	if (
		contentType.includes('application/x-www-form-urlencoded') ||
		contentType.includes('multipart/form-data')
	) {
		return await request.formData()
	}
	const formData = new FormData()
	formData.set('action', fallbackAction)
	return formData
}

async function handleVenstarMutation(input: {
	handler: string
	formData: FormData
	venstar: ReturnType<typeof createVenstarAdapter>
}) {
	const { action, formData, venstar } = input

	if (action === 'scan') {
		const discovered = await venstar.scan()
		return {
			message: `Scan complete. Discovered ${discovered.length} Venstar thermostat(s).`,
		}
	}

	if (action === 'adopt-discovered') {
		const thermostatIp = requireStringField(
			formData,
			'thermostatIp',
			'Thermostat IP',
		)
		const thermostat = await venstar.addDiscoveredThermostat(thermostatIp)
		return {
			message: `Added ${thermostat.name} (${thermostat.ip}) to managed thermostats.`,
		}
	}

	if (action === 'adopt-all-discovered') {
		const thermostats = await venstar.addAllDiscoveredThermostats()
		if (thermostats.length === 0) {
			throw new Error('No discovered Venstar thermostats are available to add.')
		}
		return {
			message: `Added ${thermostats.length} discovered Venstar thermostat(s) to managed thermostats.`,
		}
	}

	if (action === 'save-manual') {
		const thermostat = await venstar.addThermostat({
			name: requireStringField(formData, 'thermostatName', 'Thermostat name'),
			ip: requireStringField(formData, 'thermostatIp', 'Thermostat IP'),
		})
		return {
			message: `Saved ${thermostat.name} (${thermostat.ip}) to managed thermostats.`,
		}
	}

	if (action === 'remove-configured') {
		const thermostatIp = requireStringField(
			formData,
			'thermostatIp',
			'Thermostat IP',
		)
		const thermostat = venstar.removeThermostat(thermostatIp)
		return {
			message: `Removed ${thermostat.name} (${thermostat.ip}) from managed thermostats.`,
		}
	}

	throw new Error(`Unknown Venstar action "${action}".`)
}

function renderStorageNotice() {
	return html`<section class="card">
		<h2>Persistence</h2>
		<p class="muted">
			Managed Venstar thermostats are stored in the connector&apos;s local
			SQLite database and are immediately available to the UI and MCP tools.
		</p>
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
			No Venstar thermostats are managed yet. Scan and add them here, or save
			one manually from the setup page.
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

function renderConfiguredThermostatEditor(
	thermostats: Array<VenstarManagedThermostat>,
) {
	if (thermostats.length === 0) {
		return html`<p class="muted">No Venstar thermostats are managed yet.</p>`
	}

	return html`<ul class="list">
		${thermostats.map(
			(thermostat) => html`<li class="card">
				<strong>${thermostat.name}</strong>
				<div>IP: <code>${thermostat.ip}</code></div>
				<div>Last seen: ${thermostat.lastSeenAt ?? 'unknown'}</div>
				<form method="POST">
					<input type="hidden" name="action" value="remove-configured" />
					<input type="hidden" name="thermostatIp" value="${thermostat.ip}" />
					<button type="submit">Remove thermostat</button>
				</form>
			</li>`,
		)}
	</ul>`
}

function renderDiscoveredThermostatList(
	thermostats: ReturnType<
		ReturnType<typeof createVenstarAdapter>['getStatus']
	>['discovered'],
) {
	if (thermostats.length === 0) {
		return html`<p class="muted">
			No unmanaged Venstar thermostats were discovered in the last scan.
		</p>`
	}

	return html`<ul class="list">
		${thermostats.map(
			(thermostat) => html`<li class="card">
				<strong>${thermostat.name}</strong>
				<div>IP: <code>${thermostat.ip}</code></div>
				<div>Location: <code>${thermostat.location}</code></div>
				<div>Last seen: ${thermostat.lastSeenAt}</div>
				<form method="POST">
					<input type="hidden" name="action" value="adopt-discovered" />
					<input type="hidden" name="thermostatIp" value="${thermostat.ip}" />
					<button type="submit">Add to managed thermostats</button>
				</form>
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
					label: 'Scan CIDRs',
					value: html`<code>${diagnostics.discoveryUrl}</code>`,
				},
				{ label: 'Last scan', value: diagnostics.scannedAt },
				{
					label: 'Hosts probed',
					value: String(diagnostics.subnetProbe?.hostsProbed ?? 0),
				},
				{
					label: 'Venstar matches',
					value: String(diagnostics.subnetProbe?.venstarMatches ?? 0),
				},
				{ label: 'Info lookups', value: diagnostics.infoLookups.length },
			])}
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
									? html`<div>Parsed:</div>
											${renderCodeBlock(formatJson(lookup.parsed))}`
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
	config: HomeConnectorConfig
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
						Live connectivity and management for Venstar thermostats on this
						connector.
					</p>
					<p>
						<a href="/venstar/setup">Venstar setup</a>
						<span class="muted">
							— add, remove, and review managed thermostats
						</span>
					</p>
					<form method="POST">
						<input type="hidden" name="action" value="scan" />
						<button type="submit">Scan now</button>
					</form>
					${input.status.discovered.length > 0
						? html`<form method="POST">
								<input
									type="hidden"
									name="action"
									value="adopt-all-discovered"
								/>
								<button type="submit">Add all discovered thermostats</button>
							</form>`
						: ''}
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
							<strong>Managed thermostats</strong>
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
							<strong>Unmanaged discoveries</strong>
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
				${renderStorageNotice()}
				<section class="card">
					<h2>Managed thermostats</h2>
					${renderThermostatList(input.thermostats)}
				</section>
				<section class="card">
					<h2>Discovered thermostats</h2>
					<p class="muted">
						Discovery probes
						<code>/query/info</code>
						directly across the configured scan subnets, then lets you adopt the
						thermostats immediately.
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
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				const formData = await readPostedFormData(request, 'scan')
				const action =
					typeof formData.get('action') === 'string'
						? String(formData.get('action'))
						: 'scan'
				try {
					const result = await handleVenstarMutation({
						action,
						formData,
						venstar,
					})
					return renderVenstarStatusPage({
						state,
						config,
						status: venstar.getStatus(),
						thermostats: await venstar.listThermostatsWithStatus(),
						scanMessage: result.message,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/venstar/status',
							action,
						},
						contexts: {
							venstar: {
								scanCidrs: config.venstarScanCidrs,
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderVenstarStatusPage({
						state,
						config,
						status: venstar.getStatus(),
						thermostats: await venstar.listThermostatsWithStatus(),
						scanError:
							error instanceof Error
								? `Action failed: ${error.message}`
								: `Action failed: ${String(error)}`,
					})
				}
			}

			return renderVenstarStatusPage({
				state,
				config,
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
	function renderVenstarSetupPage(input: {
		saveMessage?: string | null
		saveError?: string | null
	}) {
		const thermostats = venstar.listThermostats()
		const status = venstar.getStatus()
		return render(
			RootLayout({
				title: 'home connector - venstar setup',
				body: html`<section class="card">
						<h1>Venstar setup</h1>
						<p class="muted">
							Add thermostats directly here, or scan the LAN and adopt
							discovered devices with one click.
						</p>
						<p>
							<a href="/venstar/status">Venstar status</a>
							<span class="muted">
								— scan the network and verify live thermostat status
							</span>
						</p>
						${renderInfoRows([
							{ label: 'Worker URL', value: config.workerBaseUrl },
							{
								label: 'Connector ID',
								value: state.connection.connectorId || 'not registered yet',
							},
							{
								label: 'Managed thermostats',
								value: String(thermostats.length),
							},
							{
								label: 'Unmanaged discoveries',
								value: String(status.discovered.length),
							},
							{
								label: 'Scan CIDRs',
								value: html`<code
									>${config.venstarScanCidrs.join(', ') || 'none'}</code
								>`,
							},
						])}
					</section>
					${input.saveMessage
						? renderBanner({ tone: 'success', message: input.saveMessage })
						: ''}
					${input.saveError
						? renderBanner({ tone: 'error', message: input.saveError })
						: ''}
					${renderStorageNotice()}
					<section class="card">
						<h2>Add thermostat manually</h2>
						<form method="POST">
							<input type="hidden" name="action" value="save-manual" />
							<label>
								Name
								<input
									type="text"
									name="thermostatName"
									placeholder="UPSTAIRS"
									required
								/>
							</label>
							<label>
								IP address
								<input
									type="text"
									name="thermostatIp"
									placeholder="192.168.0.71"
									required
								/>
							</label>
							<button type="submit">Save thermostat</button>
						</form>
					</section>
					<section class="card">
						<h2>Managed thermostats</h2>
						${renderConfiguredThermostatEditor(thermostats)}
					</section>
					<section class="card">
						<h2>Discovered thermostats</h2>
						<p class="muted">
							Run a scan from the Venstar status page, then add discovered
							thermostats here without editing config files.
						</p>
						${status.discovered.length > 0
							? html`<form method="POST">
									<input
										type="hidden"
										name="action"
										value="adopt-all-discovered"
									/>
									<button type="submit">Add all discovered thermostats</button>
								</form>`
							: ''}
						${renderDiscoveredThermostatList(status.discovered)}
					</section>`,
			}),
		)
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				const formData = await readPostedFormData(request, 'save-manual')
				const action =
					typeof formData.get('action') === 'string'
						? String(formData.get('action'))
						: 'save-manual'
				try {
					const result = await handleVenstarMutation({
						action,
						formData,
						venstar,
					})
					return renderVenstarSetupPage({
						saveMessage: result.message,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/venstar/setup',
							action,
						},
						contexts: {
							venstar: {
								scanCidrs: config.venstarScanCidrs,
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderVenstarSetupPage({
						saveError: error instanceof Error ? error.message : String(error),
					})
				}
			}

			return renderVenstarSetupPage({})
		},
	} satisfies BuildAction<
		typeof routes.venstarSetup.method,
		typeof routes.venstarSetup.pattern
	>
}
