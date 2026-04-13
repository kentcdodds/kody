import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { type routes } from './routes.ts'
import { type createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { type LutronDiscoveryDiagnostics } from '../src/adapters/lutron/types.ts'
import { type createBondAdapter } from '../src/adapters/bond/index.ts'
import { type createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { type RokuDiscoveryDiagnostics } from '../src/adapters/roku/types.ts'
import { scanRokuDevices } from '../src/adapters/roku/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { renderInfoRows } from './handler-utils.ts'

function renderQuickLinks(state: HomeConnectorState) {
	const workerSnapshotUrl = state.connection.connectorId
		? `${state.connection.workerUrl}/home/connectors/${encodeURIComponent(state.connection.connectorId)}/snapshot`
		: null
	return html`<ul class="list">
		<li><a href="/roku/status">Roku status</a></li>
		<li><a href="/roku/setup">Roku setup</a></li>
		<li><a href="/lutron/status">Lutron status</a></li>
		<li><a href="/lutron/setup">Lutron setup</a></li>
		<li><a href="/sonos/status">Sonos status</a></li>
		<li><a href="/sonos/setup">Sonos setup</a></li>
		<li><a href="/samsung-tv/status">Samsung TV status</a></li>
		<li><a href="/samsung-tv/setup">Samsung TV setup</a></li>
		<li><a href="/bond/status">Bond status</a></li>
		<li><a href="/bond/setup">Bond token setup</a></li>
		<li><a href="/venstar/status">Venstar status</a></li>
		<li><a href="/venstar/setup">Venstar setup</a></li>
		<li><a href="/health">Health JSON</a></li>
		${workerSnapshotUrl
			? html`<li>
					<a href="${workerSnapshotUrl}">Worker connector snapshot</a>
				</li>`
			: ''}
	</ul>`
}

function getConnectionStatusSummary(state: HomeConnectorState) {
	return state.connection.connected ? 'connected' : 'disconnected'
}

export function createHomeDashboardHandler(
	state: HomeConnectorState,
	lutron: ReturnType<typeof createLutronAdapter>,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
	sonos: ReturnType<typeof createSonosAdapter>,
	bond: ReturnType<typeof createBondAdapter>,
	venstar: ReturnType<typeof createVenstarAdapter>,
) {
	return {
		middleware: [],
		async action() {
			const discoveredCount = state.devices.filter(
				(device) => !device.adopted,
			).length
			const adoptedCount = state.devices.filter(
				(device) => device.adopted,
			).length
			const lutronStatus = lutron.getStatus()
			const samsungStatus = samsungTv.getStatus()
			const sonosStatus = sonos.getStatus()
			const bondStatus = bond.getStatus()
			const venstarStatus = await venstar.listThermostatsWithStatus()
			const onlineVenstarCount = venstarStatus.filter(
				(thermostat) => thermostat.info != null,
			).length

			return render(
				RootLayout({
					title: 'home connector - admin',
					body: html`<div class="app-shell">
						<section class="card">
							<h1>Home connector admin</h1>
							<p class="muted">
								Local admin dashboard for connection health, device state, and
								useful development links.
							</p>
						</section>

						<section class="status-grid">
							<div class="card">
								<h2>Connection</h2>
								${renderInfoRows([
									{
										label: 'Status',
										value: getConnectionStatusSummary(state),
									},
									{
										label: 'Worker',
										value: html`<code>${state.connection.workerUrl}</code>`,
									},
									{
										label: 'Connector ID',
										value: html`<code>${state.connection.connectorId}</code>`,
									},
									{
										label: 'Last sync',
										value: state.connection.lastSyncAt ?? 'never',
									},
									{
										label: 'Shared secret',
										value: state.connection.sharedSecret
											? 'configured'
											: 'missing',
									},
									{
										label: 'Last error',
										value: state.connection.lastError ?? 'none',
									},
								])}
							</div>

							<div class="card">
								<h2>Devices</h2>
								${renderInfoRows([
									{
										label: 'Roku adopted',
										value: String(adoptedCount),
									},
									{
										label: 'Roku discovered',
										value: String(discoveredCount),
									},
									{
										label: 'Lutron processors',
										value: String(lutronStatus.processors.length),
									},
									{
										label: 'Lutron credentials',
										value: String(lutronStatus.configuredCredentialsCount),
									},
									{
										label: 'Samsung adopted',
										value: String(samsungStatus.adopted.length),
									},
									{
										label: 'Samsung discovered',
										value: String(samsungStatus.discovered.length),
									},
									{
										label: 'Samsung paired',
										value: String(samsungStatus.pairedCount),
									},
									{
										label: 'Sonos adopted',
										value: String(sonosStatus.adopted.length),
									},
									{
										label: 'Sonos discovered',
										value: String(sonosStatus.discovered.length),
									},
									{
										label: 'Sonos audio input',
										value: String(sonosStatus.audioInputSupportedCount),
									},
									{
										label: 'Bond adopted',
										value: String(bondStatus.adopted.length),
									},
									{
										label: 'Bond discovered',
										value: String(bondStatus.discovered.length),
									},
									{
										label: 'Bond with token',
										value: String(
											bondStatus.bridges.filter((b) => b.hasStoredToken).length,
										),
									},
									{
										label: 'Venstar configured',
										value: String(venstarStatus.length),
									},
									{
										label: 'Venstar online',
										value: String(onlineVenstarCount),
									},
									{
										label: 'Venstar offline',
										value: String(venstarStatus.length - onlineVenstarCount),
									},
									{
										label: 'Mocks',
										value: state.connection.mocksEnabled
											? 'enabled'
											: 'disabled',
									},
								])}
							</div>

							<div class="card">
								<h2>Quick links</h2>
								${renderQuickLinks(state)}
							</div>
						</section>
					</div>`,
				}),
			)
		},
	} satisfies BuildAction<typeof routes.home.method, typeof routes.home.pattern>
}

function renderDeviceList(
	label: string,
	devices: Array<{
		deviceId: string
		name: string
		location: string
		adopted: boolean
		lastSeenAt: string | null
		controlEnabled: boolean
	}>,
) {
	if (devices.length === 0) {
		return html`<p class="muted">No ${label} Roku devices.</p>`
	}

	return html`<ul class="list">
		${devices.map(
			(device) =>
				html`<li class="card">
					<strong>${device.name}</strong>
					<div>ID: <code>${device.deviceId}</code></div>
					<div>Endpoint: <code>${device.location}</code></div>
					<div>Adopted: ${device.adopted ? 'yes' : 'no'}</div>
					<div>Control enabled: ${device.controlEnabled ? 'yes' : 'no'}</div>
					<div>Last seen: ${device.lastSeenAt ?? 'unknown'}</div>
				</li>`,
		)}
	</ul>`
}

function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2)
}

function renderCodeBlock(value: string) {
	return html`<pre><code>${value}</code></pre>`
}

function renderLutronDiscoveryDiagnostics(
	diagnostics: LutronDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">No Lutron scan diagnostics captured yet.</p>`
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
				{ label: 'Services', value: String(diagnostics.services.length) },
				{ label: 'Errors', value: String(diagnostics.errors.length) },
			])}
		</section>
		${diagnostics.jsonResponse
			? html`<section class="card">
					<h2>Raw discovery payload</h2>
					${renderCodeBlock(formatJson(diagnostics.jsonResponse))}
				</section>`
			: ''}
		<section class="card">
			<h2>Resolved services</h2>
			${diagnostics.services.length === 0
				? html`<p class="muted">No Lutron services were captured.</p>`
				: html`<ul class="list">
						${diagnostics.services.map(
							(service) =>
								html`<li class="card">
									<div>Instance: <code>${service.instanceName}</code></div>
									<div>Host: <code>${service.host ?? 'unknown'}</code></div>
									<div>Port: ${service.port ?? 'unknown'}</div>
									<div>
										Address: <code>${service.address ?? 'unknown'}</code>
									</div>
									${renderCodeBlock(service.raw)}
								</li>`,
						)}
					</ul>`}
		</section>
		${diagnostics.errors.length === 0
			? ''
			: html`<section class="card">
					<h2>Discovery errors</h2>
					<ul class="list">
						${diagnostics.errors.map((error) => html`<li>${error}</li>`)}
					</ul>
				</section>`}
	`
}

function renderLutronProcessorList(
	label: string,
	processors: Array<{
		processorId: string
		name: string
		host: string
		leapPort: number
		discoveryPort: number | null
		systemType: string | null
		codeVersion: string | null
		hasStoredCredentials: boolean
		lastSeenAt: string | null
		lastAuthenticatedAt: string | null
		lastAuthError: string | null
	}>,
) {
	if (processors.length === 0) {
		return html`<p class="muted">No ${label} Lutron processors.</p>`
	}

	return html`<ul class="list">
		${processors.map(
			(processor) =>
				html`<li class="card">
					<strong>${processor.name}</strong>
					<div>ID: <code>${processor.processorId}</code></div>
					<div>Host: <code>${processor.host}</code></div>
					<div>LEAP port: ${processor.leapPort}</div>
					<div>Discovery port: ${processor.discoveryPort ?? 'unknown'}</div>
					<div>System type: ${processor.systemType ?? 'unknown'}</div>
					<div>Code version: ${processor.codeVersion ?? 'unknown'}</div>
					<div>
						Credentials:
						${processor.hasStoredCredentials ? 'stored' : 'missing'}
					</div>
					<div>Last seen: ${processor.lastSeenAt ?? 'unknown'}</div>
					<div>
						Last auth:
						${processor.lastAuthenticatedAt ??
						processor.lastAuthError ??
						'never'}
					</div>
				</li>`,
		)}
	</ul>`
}

function renderLutronStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createLutronAdapter>['getStatus']>
	scanMessage?: string | null
	scanError?: string | null
}) {
	const withCredentials = input.status.processors.filter(
		(processor) => processor.hasStoredCredentials,
	)
	const withoutCredentials = input.status.processors.filter(
		(processor) => !processor.hasStoredCredentials,
	)

	return render(
		RootLayout({
			title: 'home connector - lutron status',
			body: html`<section class="card">
					<h1>Lutron status</h1>
					<p class="muted">
						Current connectivity and discovery state for Lutron processors
						managed by this connector.
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
							<strong>Connector ID</strong>
							<div>${input.state.connection.connectorId}</div>
						</div>
						<div>
							<strong>Stored credentials</strong>
							<div>${input.status.configuredCredentialsCount}</div>
						</div>
					</div>
				</section>
				${input.scanMessage
					? renderBanner({
							tone: 'success',
							message: input.scanMessage,
						})
					: ''}
				${input.scanError
					? renderBanner({
							tone: 'error',
							message: input.scanError,
						})
					: ''}
				<section class="card">
					<h2>Processors with credentials</h2>
					${renderLutronProcessorList('configured', withCredentials)}
				</section>
				<section class="card">
					<h2>Processors missing credentials</h2>
					${renderLutronProcessorList('discovered', withoutCredentials)}
				</section>
				${renderLutronDiscoveryDiagnostics(
					input.state.lutronDiscoveryDiagnostics,
				)}`,
		}),
	)
}

export function createLutronStatusHandler(
	state: HomeConnectorState,
	lutron: ReturnType<typeof createLutronAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const processors = await lutron.scan()
					return renderLutronStatusPage({
						state,
						status: lutron.getStatus(),
						scanMessage: `Scan complete. Discovered ${processors.length} Lutron processor(s).`,
					})
				} catch (error) {
					return renderLutronStatusPage({
						state,
						status: lutron.getStatus(),
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}

			return renderLutronStatusPage({
				state,
				status: lutron.getStatus(),
			})
		},
	} satisfies BuildAction<
		typeof routes.lutronStatus.method,
		typeof routes.lutronStatus.pattern
	>
}

export function createLutronSetupHandler(
	state: HomeConnectorState,
	lutron: ReturnType<typeof createLutronAdapter>,
) {
	return {
		middleware: [],
		async action() {
			const status = lutron.getStatus()
			const diagnostics = [
				`Worker URL: ${state.connection.workerUrl}`,
				`Connector ID: ${state.connection.connectorId}`,
				`Lutron discovery URL: ${state.lutronDiscoveryDiagnostics?.discoveryUrl ?? 'not scanned yet'}`,
				`Discovered processors: ${String(status.processors.length)}`,
				`Stored credentials: ${String(status.configuredCredentialsCount)}`,
				state.connection.mocksEnabled
					? 'Mocks are enabled for this connector instance.'
					: 'Mocks are disabled for this connector instance.',
				state.connection.lastError
					? `Last connector error: ${state.connection.lastError}`
					: 'No connector error recorded.',
			]

			return render(
				RootLayout({
					title: 'home connector - lutron setup',
					body: html`<section class="card">
						<h1>Lutron setup</h1>
						<p class="muted">
							Review connector registration, discovery status, and credential
							state for Lutron processors.
						</p>
						<ul class="list">
							${diagnostics.map((line) => html`<li>${line}</li>`)}
						</ul>
						<p class="muted">
							V1 keeps this page read-only while discovery, credential
							association, and diagnostics flow through the connector state and
							Lutron adapter.
						</p>
					</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.lutronSetup.method,
		typeof routes.lutronSetup.pattern
	>
}

function renderRokuDiscoveryDiagnostics(
	diagnostics: RokuDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">No Roku scan diagnostics captured yet.</p>`
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
				{ label: 'SSDP hits', value: String(diagnostics.ssdpHits.length) },
				{
					label: 'Device-info lookups',
					value: String(diagnostics.deviceInfoLookups.length),
				},
			])}
		</section>
		${diagnostics.jsonResponse
			? html`<section class="card">
					<h2>Raw discovery payload</h2>
					${renderCodeBlock(formatJson(diagnostics.jsonResponse))}
				</section>`
			: ''}
		<section class="card">
			<h2>Raw SSDP hits</h2>
			${diagnostics.ssdpHits.length === 0
				? html`<p class="muted">
						No SSDP hits were captured for the last scan.
					</p>`
				: html`<ul class="list">
						${diagnostics.ssdpHits.map(
							(hit) =>
								html`<li class="card">
									<div>
										From:
										<code>${hit.remoteAddress}:${String(hit.remotePort)}</code>
									</div>
									<div>Received: ${hit.receivedAt}</div>
									<div>Location: <code>${hit.location ?? 'missing'}</code></div>
									<div>USN: <code>${hit.usn ?? 'missing'}</code></div>
									<div>Server: <code>${hit.server ?? 'missing'}</code></div>
									${renderCodeBlock(hit.raw)}
								</li>`,
						)}
					</ul>`}
		</section>
		<section class="card">
			<h2>Device-info payloads</h2>
			${diagnostics.deviceInfoLookups.length === 0
				? html`<p class="muted">
						No device-info payloads were captured for the last scan.
					</p>`
				: html`<ul class="list">
						${diagnostics.deviceInfoLookups.map(
							(lookup) =>
								html`<li class="card">
									<div>Location: <code>${lookup.location}</code></div>
									<div>Request URL: <code>${lookup.deviceInfoUrl}</code></div>
									<div>Error: ${lookup.error ?? 'none'}</div>
									${lookup.parsed
										? html`<div>
												Parsed: <code>${formatJson(lookup.parsed)}</code>
											</div>`
										: ''}
									${lookup.raw
										? renderCodeBlock(lookup.raw)
										: html`<p class="muted">No raw payload captured.</p>`}
								</li>`,
						)}
					</ul>`}
		</section>
	`
}

function renderBanner(input: { tone: 'success' | 'error'; message: string }) {
	return html`<section
		class="card ${input.tone === 'error' ? 'card-error' : 'card-success'}"
	>
		<p>${input.message}</p>
	</section>`
}

export function createHealthHandler(state: HomeConnectorState) {
	return {
		middleware: [],
		async action() {
			return Response.json(
				{
					ok: true,
					service: 'home-connector',
					connectorId: state.connection.connectorId,
				},
				{
					headers: {
						'Cache-Control': 'no-store',
					},
				},
			)
		},
	} satisfies BuildAction<
		typeof routes.health.method,
		typeof routes.health.pattern
	>
}

function renderRokuStatusPage(input: {
	state: HomeConnectorState
	scanMessage?: string | null
	scanError?: string | null
}) {
	const discovered = input.state.devices.filter((device) => !device.adopted)
	const adopted = input.state.devices.filter((device) => device.adopted)

	return render(
		RootLayout({
			title: 'home connector - roku status',
			body: html`<section class="card">
					<h1>Roku status</h1>
					<p class="muted">
						Current connectivity and discovery state for this connector.
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
							<strong>Connector ID</strong>
							<div>${input.state.connection.connectorId}</div>
						</div>
						<div>
							<strong>Last sync</strong>
							<div>${input.state.connection.lastSyncAt ?? 'never'}</div>
						</div>
					</div>
				</section>
				${input.scanMessage
					? renderBanner({
							tone: 'success',
							message: input.scanMessage,
						})
					: ''}
				${input.scanError
					? renderBanner({
							tone: 'error',
							message: input.scanError,
						})
					: ''}
				<section class="card">
					<h2>Adopted devices</h2>
					${renderDeviceList('adopted', adopted)}
				</section>
				<section class="card">
					<h2>Discovered devices</h2>
					${renderDeviceList('discovered', discovered)}
				</section>
				${renderRokuDiscoveryDiagnostics(input.state.rokuDiscoveryDiagnostics)}`,
		}),
	)
}

export function createRokuStatusHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const devices = await scanRokuDevices(state, config)
					return renderRokuStatusPage({
						state,
						scanMessage: `Scan complete. Discovered ${devices.length} Roku device(s).`,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/roku/status',
							action: 'scan',
						},
						contexts: {
							roku: {
								discoveryUrl: config.rokuDiscoveryUrl,
								connectorId: config.homeConnectorId,
							},
						},
					})
					return renderRokuStatusPage({
						state,
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}

			return renderRokuStatusPage({ state })
		},
	} satisfies BuildAction<
		typeof routes.rokuStatus.method,
		typeof routes.rokuStatus.pattern
	>
}

export function createRokuSetupHandler(state: HomeConnectorState) {
	return {
		middleware: [],
		async action() {
			const diagnostics = [
				`Worker URL: ${state.connection.workerUrl}`,
				`Connector ID: ${state.connection.connectorId}`,
				state.connection.sharedSecret
					? 'Shared secret is configured.'
					: 'Shared secret is missing.',
				state.connection.mocksEnabled
					? 'Mocks are enabled for this connector instance.'
					: 'Mocks are disabled for this connector instance.',
				state.connection.lastError
					? `Last error: ${state.connection.lastError}`
					: 'No connector error recorded.',
			]

			return render(
				RootLayout({
					title: 'home connector - roku setup',
					body: html`<section class="card">
						<h1>Roku setup</h1>
						<p class="muted">
							Review connector registration, discovery status, and diagnostics.
						</p>
						<ul class="list">
							${diagnostics.map((line) => html`<li>${line}</li>`)}
						</ul>
						<p class="muted">
							V1 keeps this page read-only while adoption and diagnostics flow
							through the connector state and Roku adapter.
						</p>
					</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.rokuSetup.method,
		typeof routes.rokuSetup.pattern
	>
}

function renderSamsungTvDeviceList(
	label: string,
	devices: Array<{
		deviceId: string
		name: string
		host: string
		modelName: string | null
		powerState: string | null
		adopted: boolean
		token: string | null
		lastSeenAt: string | null
	}>,
) {
	if (devices.length === 0) {
		return html`<p class="muted">No ${label} Samsung TVs.</p>`
	}

	return html`<ul class="list">
		${devices.map(
			(device) =>
				html`<li class="card">
					<strong>${device.name}</strong>
					<div>ID: <code>${device.deviceId}</code></div>
					<div>Host: <code>${device.host}</code></div>
					<div>Model: ${device.modelName ?? 'unknown'}</div>
					<div>Power state: ${device.powerState ?? 'unknown'}</div>
					<div>Adopted: ${device.adopted ? 'yes' : 'no'}</div>
					<div>Paired: ${device.token ? 'yes' : 'no'}</div>
					<div>Last seen: ${device.lastSeenAt ?? 'unknown'}</div>
				</li>`,
		)}
	</ul>`
}

function renderSamsungTvDiscoveryDiagnostics(
	diagnostics: HomeConnectorState['samsungTvDiscoveryDiagnostics'],
) {
	if (!diagnostics) {
		return html`<p class="muted">
			No Samsung TV scan diagnostics captured yet.
		</p>`
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
				{ label: 'Services', value: String(diagnostics.services.length) },
				{
					label: 'Metadata lookups',
					value: String(diagnostics.metadataLookups.length),
				},
			])}
		</section>
		${diagnostics.jsonResponse
			? html`<section class="card">
					<h2>Raw discovery payload</h2>
					${renderCodeBlock(formatJson(diagnostics.jsonResponse))}
				</section>`
			: ''}
		<section class="card">
			<h2>Resolved services</h2>
			${diagnostics.services.length === 0
				? html`<p class="muted">No Samsung TV services were captured.</p>`
				: html`<ul class="list">
						${diagnostics.services.map(
							(service) =>
								html`<li class="card">
									<div>Instance: <code>${service.instanceName}</code></div>
									<div>Host: <code>${service.host ?? 'unknown'}</code></div>
									<div>
										Resolved IPv4:
										<code>${service.address ?? 'none'}</code>
									</div>
									<div>Port: ${service.port ?? 'unknown'}</div>
									<div>
										Service URL: <code>${service.txt['se'] ?? 'missing'}</code>
									</div>
									${renderCodeBlock(service.raw)}
								</li>`,
						)}
					</ul>`}
		</section>
		<section class="card">
			<h2>Device-info payloads</h2>
			${diagnostics.metadataLookups.length === 0
				? html`<p class="muted">
						No Samsung TV metadata lookups were captured.
					</p>`
				: html`<ul class="list">
						${diagnostics.metadataLookups.map(
							(lookup) =>
								html`<li class="card">
									<div>Service URL: <code>${lookup.serviceUrl}</code></div>
									<div>Request URL: <code>${lookup.deviceInfoUrl}</code></div>
									<div>Error: ${lookup.error ?? 'none'}</div>
									${lookup.parsed
										? renderCodeBlock(formatJson(lookup.parsed))
										: html`<p class="muted">No parsed payload captured.</p>`}
									${lookup.raw
										? renderCodeBlock(lookup.raw)
										: html`<p class="muted">No raw payload captured.</p>`}
								</li>`,
						)}
					</ul>`}
		</section>
	`
}

function renderSamsungTvStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createSamsungTvAdapter>['getStatus']>
	scanMessage?: string | null
	scanError?: string | null
}) {
	return render(
		RootLayout({
			title: 'home connector - samsung tv status',
			body: html`<section class="card">
					<h1>Samsung TV status</h1>
					<p class="muted">
						Current connectivity and discovery state for Samsung TVs managed by
						this connector.
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
							<strong>Connector ID</strong>
							<div>${input.state.connection.connectorId}</div>
						</div>
						<div>
							<strong>Paired TVs</strong>
							<div>${input.status.pairedCount}</div>
						</div>
					</div>
				</section>
				${input.scanMessage
					? renderBanner({
							tone: 'success',
							message: input.scanMessage,
						})
					: ''}
				${input.scanError
					? renderBanner({
							tone: 'error',
							message: input.scanError,
						})
					: ''}
				<section class="card">
					<h2>Adopted TVs</h2>
					${renderSamsungTvDeviceList('adopted', input.status.adopted)}
				</section>
				<section class="card">
					<h2>Discovered TVs</h2>
					${renderSamsungTvDeviceList('discovered', input.status.discovered)}
				</section>
				${renderSamsungTvDiscoveryDiagnostics(
					input.state.samsungTvDiscoveryDiagnostics,
				)}`,
		}),
	)
}

export function createSamsungTvStatusHandler(
	state: HomeConnectorState,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const devices = await samsungTv.scan()
					return renderSamsungTvStatusPage({
						state,
						status: samsungTv.getStatus(),
						scanMessage: `Scan complete. Discovered ${devices.length} Samsung TV device(s).`,
					})
				} catch (error) {
					return renderSamsungTvStatusPage({
						state,
						status: samsungTv.getStatus(),
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}

			return renderSamsungTvStatusPage({
				state,
				status: samsungTv.getStatus(),
			})
		},
	} satisfies BuildAction<
		typeof routes.samsungTvStatus.method,
		typeof routes.samsungTvStatus.pattern
	>
}

export function createSamsungTvSetupHandler(
	state: HomeConnectorState,
	samsungTv: ReturnType<typeof createSamsungTvAdapter>,
) {
	return {
		middleware: [],
		async action() {
			const status = samsungTv.getStatus()
			const diagnostics = [
				`Worker URL: ${state.connection.workerUrl}`,
				`Connector ID: ${state.connection.connectorId}`,
				`Samsung discovery URL: ${state.samsungTvDiscoveryDiagnostics?.discoveryUrl ?? 'not scanned yet'}`,
				`Paired Samsung TVs: ${String(status.pairedCount)}`,
				state.connection.mocksEnabled
					? 'Mocks are enabled for this connector instance.'
					: 'Mocks are disabled for this connector instance.',
				state.connection.lastError
					? `Last connector error: ${state.connection.lastError}`
					: 'No connector error recorded.',
			]

			return render(
				RootLayout({
					title: 'home connector - samsung tv setup',
					body: html`<section class="card">
						<h1>Samsung TV setup</h1>
						<p class="muted">
							Review connector registration, discovery status, pairing state,
							and diagnostics for Samsung TVs.
						</p>
						<ul class="list">
							${diagnostics.map((line) => html`<li>${line}</li>`)}
						</ul>
						<p class="muted">
							V1 keeps this page read-only while pairing and diagnostics flow
							through the connector state and Samsung TV adapter.
						</p>
					</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.samsungTvSetup.method,
		typeof routes.samsungTvSetup.pattern
	>
}
