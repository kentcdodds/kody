import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { render } from './render.ts'
import { RootLayout } from './root.tsx'
import { type routes } from './routes.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { type RokuDiscoveryDiagnostics } from '../src/adapters/roku/types.ts'
import { scanRokuDevices } from '../src/adapters/roku/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'

function renderQuickLinks(state: HomeConnectorState) {
	const workerSnapshotUrl = state.connection.connectorId
		? `${state.connection.workerUrl}/home/connectors/${encodeURIComponent(state.connection.connectorId)}/snapshot`
		: null
	return html`<ul class="list">
		<li><a href="/roku/status">Roku status</a></li>
		<li><a href="/roku/setup">Roku setup</a></li>
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

function renderInfoRows(
	rows: Array<{
		label: string
		value: string | ReturnType<typeof html>
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

export function createHomeDashboardHandler(state: HomeConnectorState) {
	return {
		middleware: [],
		async action() {
			const discoveredCount = state.devices.filter(
				(device) => !device.adopted,
			).length
			const adoptedCount = state.devices.filter(
				(device) => device.adopted,
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
										label: 'Adopted',
										value: String(adoptedCount),
									},
									{
										label: 'Discovered',
										value: String(discoveredCount),
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
