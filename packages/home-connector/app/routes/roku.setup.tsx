import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { RootLayout } from '../root.tsx'
import { render } from '../render.ts'
import { type routes } from '../routes.ts'
import { getRouteHandlers } from '../handlers.ts'

export const rokuSetup = {
	middleware: [],
	async action() {
		const state = getRouteHandlers().getSetupState()
		const diagnostics = [
			state.workerUrl
				? `Worker URL configured: ${state.workerUrl}`
				: 'Worker URL is not configured.',
			state.sharedSecretConfigured
				? 'Shared secret is configured.'
				: 'Shared secret is missing.',
			state.connectorId
				? `Connector ID: ${state.connectorId}`
				: 'Connector ID is missing.',
			state.mocksEnabled
				? 'Mocks are enabled for this connector instance.'
				: 'Mocks are disabled for this connector instance.',
		]

		return render(
			RootLayout({
				title: 'Home Connector - Roku Setup',
				children: html`<main class="app-shell">
					<h1>Roku setup</h1>
					<p>Review connector registration and Roku discovery diagnostics.</p>
					<ul>
						${diagnostics.map((line) => html`<li>${line}</li>`)}
					</ul>
					<p>
						V1 remains read-only here. Device adoption and manual add-by-IP will be
						implemented on top of the connector state and Roku adapter.
					</p>
				</main>`,
				entryScripts: false,
			}),
		)
	},
} satisfies BuildAction<
	typeof routes.rokuSetup.method,
	typeof routes.rokuSetup.pattern
>
