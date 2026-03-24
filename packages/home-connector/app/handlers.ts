import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { render } from './render.ts'
import { RootLayout } from './root.tsx'
import type { routes } from './routes.ts'
import { type HomeConnectorState } from '../src/state.ts'

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
			(device) => html`<li class="card">
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
	} satisfies BuildAction<typeof routes.health.method, typeof routes.health.pattern>
}

export function createRokuStatusHandler(state: HomeConnectorState) {
	return {
		middleware: [],
		async action() {
			const discovered = state.devices.filter((device) => !device.adopted)
			const adopted = state.devices.filter((device) => device.adopted)

			return render(
				RootLayout({
					title: 'home connector - roku status',
					body: html`<section class="card">
							<h1>Roku status</h1>
							<div class="status-grid">
								<div>
									<strong>Worker connection</strong>
									<div>${state.connection.connected ? 'connected' : 'disconnected'}</div>
								</div>
								<div>
									<strong>Connector ID</strong>
									<div>${state.connection.connectorId}</div>
								</div>
								<div>
									<strong>Last sync</strong>
									<div>${state.connection.lastSyncAt ?? 'never'}</div>
								</div>
							</div>
						</section>
						<section class="card">
							<h2>Adopted devices</h2>
							${renderDeviceList('adopted', adopted)}
						</section>
						<section class="card">
							<h2>Discovered devices</h2>
							${renderDeviceList('discovered', discovered)}
						</section>`,
				}),
			)
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
