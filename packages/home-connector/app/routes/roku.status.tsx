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
		return html`<p>No ${label} Roku devices.</p>`
	}

	return html`<ul>
		${devices.map(
			(device) => html`<li>
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
				body: html`<section class="card">
					<h1>Roku status</h1>
					<p>Worker connection: ${data.connected ? 'connected' : 'disconnected'}</p>
					<p>Connector ID: ${data.connectorId || 'not configured'}</p>
					<p>Last sync: ${data.lastConnectedAt ?? 'never'}</p>
					${data.lastError
						? html`<p>Last error: ${data.lastError}</p>`
						: ''}
				</section>
				<section class="card">
						<h2>Adopted devices</h2>
						${renderDeviceList('adopted', data.adopted)}
				</section>
				<section class="card">
						<h2>Discovered devices</h2>
						${renderDeviceList('discovered', data.discovered)}
				</section>`,
			}),
		)
	},
} satisfies BuildAction<
	typeof routes.rokuStatus.method,
	typeof routes.rokuStatus.pattern
>
