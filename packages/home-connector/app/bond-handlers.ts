import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { type createBondAdapter } from '../src/adapters/bond/index.ts'
import { type BondDiscoveryDiagnostics } from '../src/adapters/bond/types.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { type routes } from './routes.ts'

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

function renderBondDiscoveryDiagnostics(
	diagnostics: BondDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">No Bond scan diagnostics captured yet.</p>`
	}
	return html`
		<section class="card">
			<h2>Discovery diagnostics</h2>
			<div class="info-list">
				<div class="info-row">
					<div class="info-label">Protocol</div>
					<div class="info-value">${diagnostics.protocol}</div>
				</div>
				<div class="info-row">
					<div class="info-label">Discovery URL</div>
					<div class="info-value">
						<code>${diagnostics.discoveryUrl}</code>
					</div>
				</div>
				<div class="info-row">
					<div class="info-label">Last scan</div>
					<div class="info-value">${diagnostics.scannedAt}</div>
				</div>
			</div>
			${diagnostics.errors.length > 0
				? html`<section class="card card-error">
						<h3>Errors</h3>
						<ul class="list">
							${diagnostics.errors.map((error) => html`<li>${error}</li>`)}
						</ul>
					</section>`
				: ''}
			${diagnostics.services.length > 0
				? html`<section class="card">
						<h3>mDNS services</h3>
						<ul class="list">
							${diagnostics.services.map(
								(service) =>
									html`<li class="card">
										<div>
											<strong>${service.instanceName}</strong>
										</div>
										<div>Host: <code>${service.host ?? ''}</code></div>
										<div>Port: ${String(service.port ?? '')}</div>
										<div>Address: <code>${service.address ?? ''}</code></div>
									</li>`,
							)}
						</ul>
					</section>`
				: ''}
			${diagnostics.jsonResponse
				? html`<section class="card">
						<h3>Raw discovery payload</h3>
						${renderCodeBlock(formatJson(diagnostics.jsonResponse))}
					</section>`
				: ''}
		</section>
	`
}

function renderBondStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createBondAdapter>['getStatus']>
	scanMessage?: string | null
	scanError?: string | null
}) {
	return render(
		RootLayout({
			title: 'home connector - bond status',
			body: html`<section class="card">
					<h1>Bond status</h1>
					<p class="muted">
						Discovered Bond bridges, adoption state, and stored token presence.
					</p>
					<p>
						<a href="/bond/setup">Bond token setup</a>
						<span class="muted"> — paste or retrieve the local API token</span>
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
							<strong>Adopted bridges</strong>
							<div>${input.status.adopted.length}</div>
						</div>
						<div>
							<strong>Discovered bridges</strong>
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
					<h2>Bridges</h2>
					${input.status.bridges.length === 0
						? html`<p class="muted">No Bond bridges are known yet.</p>`
						: html`<ul class="list">
								${input.status.bridges.map(
									(bridge) =>
										html`<li class="card">
											<strong>${bridge.instanceName}</strong>
											<div>ID: <code>${bridge.bridgeId}</code></div>
											<div>
												Host:
												<code>${bridge.host}:${String(bridge.port)}</code>
											</div>
											<div>Model: ${bridge.model ?? 'unknown'}</div>
											<div>Firmware: ${bridge.fwVer ?? 'unknown'}</div>
											<div>Adopted: ${bridge.adopted ? 'yes' : 'no'}</div>
											<div>
												Token stored: ${bridge.hasStoredToken ? 'yes' : 'no'}
											</div>
										</li>`,
								)}
							</ul>`}
				</section>
				${renderBondDiscoveryDiagnostics(input.state.bondDiscoveryDiagnostics)}`,
		}),
	)
}

export function createBondStatusHandler(
	state: HomeConnectorState,
	bond: ReturnType<typeof createBondAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const bridges = await bond.scan()
					const status = bond.getStatus()
					return renderBondStatusPage({
						state,
						status,
						scanMessage: `Scan complete. Discovered ${bridges.length} Bond bridge(s).`,
					})
				} catch (error) {
					const status = bond.getStatus()
					captureHomeConnectorException(error, {
						tags: {
							route: '/bond/status',
							action: 'scan',
						},
						contexts: {
							bond: {
								discoveryUrl:
									state.bondDiscoveryDiagnostics?.discoveryUrl ?? 'unknown',
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderBondStatusPage({
						state,
						status,
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}
			return renderBondStatusPage({
				state,
				status: bond.getStatus(),
			})
		},
	} satisfies BuildAction<
		typeof routes.bondStatus.method,
		typeof routes.bondStatus.pattern
	>
}

function renderBondSetupPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createBondAdapter>['getStatus']>
	banner?: { tone: 'success' | 'error'; message: string } | null
}) {
	const bridges = input.status.bridges
	const bridgeOptions = bridges.map(
		(bridge) =>
			html`<option value="${bridge.bridgeId}">
				${bridge.instanceName} (${bridge.bridgeId}) — token:
				${bridge.hasStoredToken ? 'yes' : 'no'} — adopted:
				${bridge.adopted ? 'yes' : 'no'}
			</option>`,
	)
	const nonAdopted = bridges.filter((bridge) => !bridge.adopted)
	const adoptOptions = nonAdopted.map(
		(bridge) =>
			html`<option value="${bridge.bridgeId}">
				${bridge.instanceName} (${bridge.bridgeId})
			</option>`,
	)

	return render(
		RootLayout({
			title: 'home connector - bond setup',
			body: html`<section class="card page-header">
					<h1>Bond setup</h1>
					<p class="muted">
						Store the Bond local API token on this connector (SQLite) so
						automation can control devices. Tokens are not shown back after
						saving. For the same steps as MCP text later, call
						<code>bond_authentication_guide</code>.
					</p>
					<p>
						<a href="/bond/status">Bond status</a>
						<span class="muted"> — scan the network for bridges first</span>
					</p>
					<p class="muted">
						Override discovery with <code>BOND_DISCOVERY_URL</code> (mDNS URL or
						HTTP JSON discovery document).
					</p>
					<p class="muted">
						Connector ID <code>${input.state.connection.connectorId}</code> ·
						Mocks
						<code>${String(input.state.connection.mocksEnabled)}</code>
					</p>
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Save pasted token</h2>
					<p class="muted">
						Copy the token from the Bond app (device settings), paste it here,
						and save. Adopt the bridge first if you plan to use device control
						from this connector.
					</p>
					${bridges.length === 0
						? html`<p class="muted">
								No bridges are known yet. Run a scan from Bond status.
							</p>`
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="save-token" />
								<label>
									Bridge
									<select name="bridgeId" required>
										${bridgeOptions}
									</select>
								</label>
								<label>
									Token
									<textarea
										name="token"
										required
										autocomplete="off"
										placeholder="Paste Bond local API token"
									></textarea>
								</label>
								<div class="form-actions">
									<button type="submit">Save token</button>
								</div>
							</form>`}
				</section>
				<section class="card">
					<h2>Retrieve token from bridge</h2>
					<p class="muted">
						When the bridge allows it (for example within ~10 minutes after a
						power cycle, or while the token endpoint is unlocked), this asks the
						bridge for <code>/v2/token</code> and stores the result — nothing is
						displayed in the browser.
					</p>
					${bridges.length === 0
						? html`<p class="muted">
								No bridges are known yet. Run a scan from Bond status.
							</p>`
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="fetch-token" />
								<label>
									Bridge
									<select name="bridgeId" required>
										${bridgeOptions}
									</select>
								</label>
								<div class="form-actions">
									<button type="submit">Retrieve and save token</button>
								</div>
							</form>`}
				</section>
				<section class="card">
					<h2>Adopt bridge</h2>
					<p class="muted">
						Adoption marks a discovered bridge as managed by this connector
						(required for most control tools).
					</p>
					${nonAdopted.length === 0
						? html`<p class="muted">
								Every known bridge is already adopted, or none are discovered
								yet.
							</p>`
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="adopt-bridge" />
								<label>
									Bridge
									<select name="bridgeId" required>
										${adoptOptions}
									</select>
								</label>
								<div class="form-actions">
									<button type="submit">Adopt bridge</button>
								</div>
							</form>`}
				</section>`,
		}),
	)
}

export function createBondSetupHandler(
	state: HomeConnectorState,
	bond: ReturnType<typeof createBondAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			let banner: { tone: 'success' | 'error'; message: string } | null = null

			if (request.method === 'POST') {
				try {
					const form = await request.formData()
					const intent = String(form.get('intent') ?? '')

					if (intent === 'save-token') {
						const bridgeId = String(form.get('bridgeId') ?? '').trim()
						const token = String(form.get('token') ?? '').trim()
						if (!bridgeId) {
							throw new Error('Choose a bridge.')
						}
						if (!token) {
							throw new Error('Paste your Bond token before saving.')
						}
						bond.setToken(bridgeId, token)
						banner = {
							tone: 'success',
							message: `Saved token for bridge ${bridgeId}.`,
						}
					} else if (intent === 'fetch-token') {
						const bridgeId = String(form.get('bridgeId') ?? '').trim()
						if (!bridgeId) {
							throw new Error('Choose a bridge.')
						}
						await bond.syncTokenFromBridge(bridgeId)
						banner = {
							tone: 'success',
							message: `Retrieved token from bridge ${bridgeId} and saved it locally.`,
						}
					} else if (intent === 'adopt-bridge') {
						const bridgeId = String(form.get('bridgeId') ?? '').trim()
						if (!bridgeId) {
							throw new Error('Choose a bridge.')
						}
						const bridge = bond.adoptBridge(bridgeId)
						banner = {
							tone: 'success',
							message: `Adopted bridge ${bridge.instanceName} (${bridge.bridgeId}).`,
						}
					} else {
						banner = {
							tone: 'error',
							message: 'Unknown form action.',
						}
					}
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/bond/setup',
							action: 'form',
						},
						contexts: {
							bond: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					banner = {
						tone: 'error',
						message:
							error instanceof Error
								? error.message
								: `Request failed: ${String(error)}`,
					}
				}
			}

			return renderBondSetupPage({
				state,
				status: bond.getStatus(),
				banner,
			})
		},
	} satisfies BuildAction<
		typeof routes.bondSetup.method,
		typeof routes.bondSetup.pattern
	>
}
