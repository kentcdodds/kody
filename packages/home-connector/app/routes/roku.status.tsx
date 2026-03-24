import { html } from 'remix/html-template'
import { type BuildAction } from 'remix/fetch-router'
import { getRokuStatusPageData } from '../handlers.ts'
import { render } from '../render.ts'
import { RootLayout } from '../root.tsx'
import { type routes } from '../routes.ts'

function renderDeviceList(
	label: string,
	devices: Awaited<ReturnType<typeof getRokuStatusPageData>>['discovered'],
) {
	if (devices.length === 0) {
		return html`<p class="muted">No ${label} Roku devices.</p>`
	}

	return html`<ul class="list">
		${devices.map(
			(device) =>
				html`<li>
					<strong>${device.name}</strong>
					<div>ID: <code>${device.deviceId}</code></div>
					<div>Endpoint: <code>${device.location ?? 'unknown'}</code></div>
					<div>Adopted: ${device.adopted ? 'yes' : 'no'}</div>
					<div>Last seen: ${device.lastSeenAt ?? 'unknown'}</div>
				</li>`,
		)}
	</ul>`
}

export const rokuStatus = {
	middleware: [],
	async action() {
		const data = await getRokuStatusPageData()

		return render(
			RootLayout({
				title: 'home connector - roku status',
				body: html`<section class="stack">
					<section class="card">
						<header class="page-header">
							<h1>Roku status</h1>
							<p class="muted">
								Current connectivity and discovery state for this connector.
							</p>
						</header>
						<div class="status-grid">
							<div class="card">
								<h2>Worker connection</h2>
								<p>${data.connected ? 'Connected' : 'Disconnected'}</p>
							</div>
							<div class="card">
								<h2>Connector ID</h2>
								<p>${data.connectorId || 'Not configured'}</p>
							</div>
							<div class="card">
								<h2>Last sync</h2>
								<p>${data.lastConnectedAt ?? 'Never'}</p>
							</div>
						</div>
						${data.lastError
							? html`<section class="card">
									<h2>Last error</h2>
									<p>${data.lastError}</p>
								</section>`
							: ''}
					</section>
					<section class="card">
						<h2>Adopted devices</h2>
						${renderDeviceList('adopted', data.adopted)}
					</section>
					<section class="card">
						<h2>Discovered devices</h2>
						${renderDeviceList('discovered', data.discovered)}
					</section>
				</section>`,
			}),
		)
	},
} satisfies BuildAction<
	typeof routes.rokuStatus.method,
	typeof routes.rokuStatus.pattern
>
