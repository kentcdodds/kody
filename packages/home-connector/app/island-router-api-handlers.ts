import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { renderEmptyState } from './admin-ui.ts'
import { renderBanner, renderInfoRows } from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createIslandRouterApiAdapter } from '../src/adapters/island-router-api/index.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'

type Banner = { tone: 'success' | 'error'; message: string } | null

type IslandRouterApiAdapter = ReturnType<typeof createIslandRouterApiAdapter>

function renderIslandRouterApiStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<IslandRouterApiAdapter['getStatus']>
}) {
	const { status } = input
	return render(
		RootLayout({
			title: 'home connector - island router api status',
			currentPath: routes.islandRouterApiStatus.pattern,
			body: html`<section class="card">
					<h1>Island Router API status</h1>
					<p class="muted">
						Review readiness for the LAN-only Island Router HTTP API proxy. The
						proxy uses the connector WebSocket for Worker access and stores the
						Island PIN locally in encrypted SQLite storage.
					</p>
					<p>
						<a href="${routes.islandRouterApiSetup.pattern}"
							>Island Router API setup</a
						>
						<span class="muted">— save or clear the local PIN</span>
					</p>
					${renderInfoRows([
						{
							label: 'Worker connection',
							value: input.state.connection.connected
								? 'connected'
								: 'disconnected',
						},
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Configured',
							value: status.configured ? 'yes' : 'no',
						},
						{
							label: 'PIN stored',
							value: status.hasStoredPin ? 'yes' : 'no',
						},
						{
							label: 'Base URL',
							value: html`<code>${status.baseUrl}</code>`,
						},
						{
							label: 'Last auth success',
							value: status.lastAuthenticatedAt ?? 'never',
						},
						{
							label: 'Last auth error',
							value: status.lastAuthError ?? 'none',
						},
					])}
				</section>
				<section class="card">
					<h2>Usage</h2>
					<p class="muted">
						After a PIN is stored, callers can use
						<code>island_router_api_request</code> for guarded proxied requests
						under <code>/api/</code>. Non-GET requests still require the MCP
						tool's high-risk confirmation fields.
					</p>
				</section>`,
		}),
	)
}

function renderIslandRouterApiSetupPage(input: {
	state: HomeConnectorState
	status: ReturnType<IslandRouterApiAdapter['getStatus']>
	banner: Banner
}) {
	const { status } = input
	return render(
		RootLayout({
			title: 'home connector - island router api setup',
			currentPath: routes.islandRouterApiSetup.pattern,
			body: html`<section class="card">
					<h1>Island Router API setup</h1>
					<p class="muted">
						Store the Island Router PIN locally so the connector can complete
						the Island startup challenge from inside the LAN. The saved PIN is
						encrypted with <code>HOME_CONNECTOR_SHARED_SECRET</code> and is
						never rendered back to the browser.
					</p>
					<p>
						<a href="${routes.islandRouterApiStatus.pattern}"
							>Island Router API status</a
						>
						<span class="muted">— review API proxy readiness</span>
					</p>
					${renderInfoRows([
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Configured',
							value: status.configured ? 'yes' : 'no',
						},
						{
							label: 'PIN stored',
							value: status.hasStoredPin ? 'yes' : 'no',
						},
						{
							label: 'Base URL',
							value: html`<code>${status.baseUrl}</code>`,
						},
						{
							label: 'Last auth error',
							value: status.lastAuthError ?? 'none',
						},
					])}
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Set PIN</h2>
					<p class="muted">
						Enter the PIN you use for Island Router local API access. Saving a
						new PIN replaces any PIN currently stored for this connector.
					</p>
					<form method="POST" class="field-stack">
						<input type="hidden" name="intent" value="set-pin" />
						<label>
							PIN
							<input
								type="password"
								name="pin"
								required
								autocomplete="off"
								inputmode="numeric"
								placeholder="Island Router PIN"
							/>
						</label>
						<div class="form-actions">
							<button type="submit">Save PIN</button>
						</div>
					</form>
				</section>
				<section class="card">
					<h2>Clear PIN</h2>
					<p class="muted">
						Remove the encrypted PIN and clear in-memory Island Router API
						tokens. Existing SSH diagnostics settings are not affected.
					</p>
					${status.hasStoredPin
						? html`<form method="POST">
								<input type="hidden" name="intent" value="clear-pin" />
								<button type="submit">Clear stored PIN</button>
							</form>`
						: renderEmptyState('No Island Router API PIN is stored locally.')}
				</section>`,
		}),
	)
}

export function createIslandRouterApiStatusHandler(
	state: HomeConnectorState,
	islandRouterApi: IslandRouterApiAdapter,
) {
	return {
		middleware: [],
		async handler() {
			return renderIslandRouterApiStatusPage({
				state,
				status: islandRouterApi.getStatus(),
			})
		},
	} satisfies BuildAction<
		typeof routes.islandRouterApiStatus.method,
		typeof routes.islandRouterApiStatus.pattern
	>
}

export function createIslandRouterApiSetupHandler(
	state: HomeConnectorState,
	islandRouterApi: IslandRouterApiAdapter,
) {
	function renderPage(banner: Banner = null) {
		return renderIslandRouterApiSetupPage({
			state,
			status: islandRouterApi.getStatus(),
			banner,
		})
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const form = await request.formData()
					const intent = String(form.get('intent') ?? '')

					if (intent === 'set-pin') {
						islandRouterApi.setPin(String(form.get('pin') ?? ''))
						return renderPage({
							tone: 'success',
							message: 'Saved Island Router API PIN.',
						})
					}

					if (intent === 'clear-pin') {
						islandRouterApi.clearPin()
						return renderPage({
							tone: 'success',
							message: 'Cleared Island Router API PIN.',
						})
					}

					return renderPage({
						tone: 'error',
						message: 'Unknown form action.',
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/island-router-api/setup',
							action: 'form',
						},
						contexts: {
							islandRouterApi: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderPage({
						tone: 'error',
						message:
							error instanceof Error
								? error.message
								: `Request failed: ${String(error)}`,
					})
				}
			}

			return renderPage()
		},
	} satisfies BuildAction<
		typeof routes.islandRouterApiSetup.method,
		typeof routes.islandRouterApiSetup.pattern
	>
}
