import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { renderDataTable, renderEmptyState } from './admin-ui.ts'
import {
	formatJson,
	renderBanner,
	renderCodeBlock,
	renderInfoRows,
} from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import {
	type AccessNetworksUnleashedDiscoveryDiagnostics,
	type AccessNetworksUnleashedPublicController,
} from '../src/adapters/access-networks-unleashed/types.ts'
import { type createAccessNetworksUnleashedAdapter } from '../src/adapters/access-networks-unleashed/index.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorState } from '../src/state.ts'

type Banner = { tone: 'success' | 'error'; message: string } | null

function renderControllerOptions(
	controllers: Array<AccessNetworksUnleashedPublicController>,
) {
	return controllers.map(
		(controller) =>
			html`<option value="${controller.controllerId}">
				${controller.name} (${controller.controllerId}) — adopted:
				${controller.adopted ? 'yes' : 'no'} — auth:
				${controller.hasStoredCredentials ? 'stored' : 'missing'}
			</option>`,
	)
}

function renderAccessNetworksUnleashedControllerList(
	label: string,
	controllers: Array<AccessNetworksUnleashedPublicController>,
) {
	if (controllers.length === 0) {
		return renderEmptyState(
			`No ${label} Access Networks Unleashed controllers.`,
		)
	}

	return html`<ul class="list">
		${controllers.map(
			(controller) =>
				html`<li class="card">
					<strong>${controller.name}</strong>
					<div>ID: <code>${controller.controllerId}</code></div>
					<div>Host: <code>${controller.host}</code></div>
					<div>Login URL: <code>${controller.loginUrl}</code></div>
					<div>Adopted: ${controller.adopted ? 'yes' : 'no'}</div>
					<div>
						Auth info:
						${controller.hasStoredCredentials ? 'stored locally' : 'missing'}
					</div>
					<div>Last seen: ${controller.lastSeenAt ?? 'unknown'}</div>
					<div>
						Last auth success: ${controller.lastAuthenticatedAt ?? 'never'}
					</div>
					<div>Last auth error: ${controller.lastAuthError ?? 'none'}</div>
				</li>`,
		)}
	</ul>`
}

function renderAccessNetworksUnleashedDiscoveryDiagnostics(
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return renderEmptyState(
			'No Access Networks Unleashed scan diagnostics captured yet.',
		)
	}

	return html`
		<section class="card">
			<h2>Discovery diagnostics</h2>
			${renderInfoRows([
				{ label: 'Protocol', value: diagnostics.protocol },
				{
					label: 'Discovery target',
					value: html`<code>${diagnostics.discoveryUrl}</code>`,
				},
				{ label: 'Last scan', value: diagnostics.scannedAt },
				{
					label: 'CIDRs',
					value: html`<code>${diagnostics.subnetProbe.cidrs.join(', ')}</code>`,
				},
				{
					label: 'Hosts probed',
					value: diagnostics.subnetProbe.hostsProbed,
				},
				{
					label: 'Controller matches',
					value: diagnostics.subnetProbe.controllerMatches,
				},
			])}
		</section>
		<section class="card">
			<h2>Probe results</h2>
			${renderDataTable({
				headers: [
					'Host',
					'URL',
					'Matched',
					'Status',
					'Reason',
					'Location',
					'Error',
				],
				rows: diagnostics.probes.map((probe) => [
					html`<code>${probe.host}</code>`,
					html`<code>${probe.url}</code>`,
					probe.matched ? 'yes' : 'no',
					probe.status ?? 'n/a',
					probe.matchReason ?? 'none',
					probe.location ? html`<code>${probe.location}</code>` : 'none',
					probe.error ?? 'none',
				]),
				className: 'data-table-diagnostics',
			})}
		</section>
		<section class="card">
			<h2>Raw probe payload</h2>
			${renderCodeBlock(formatJson(diagnostics))}
		</section>
	`
}

function renderAccessNetworksUnleashedStatusPage(input: {
	state: HomeConnectorState
	configStatus: ReturnType<
		ReturnType<typeof createAccessNetworksUnleashedAdapter>['getConfigStatus']
	>
	controllers: Array<AccessNetworksUnleashedPublicController>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null
	scanMessage?: string | null
	scanError?: string | null
}) {
	const { configStatus, controllers } = input
	return render(
		RootLayout({
			title: 'home connector - access networks unleashed status',
			currentPath: routes.accessNetworksUnleashedStatus.pattern,
			body: html`<section class="card">
					<h1>Access Networks Unleashed status</h1>
					<p class="muted">
						Scan for controllers, review adoption and auth readiness, and
						inspect the latest discovery probe diagnostics. Live device state is
						no longer fetched from this page; the connector now exposes a single
						generic
						<code>access_networks_unleashed_request</code> capability that
						higher-level callers can wrap as needed.
					</p>
					<p>
						<a href="${routes.accessNetworksUnleashedSetup.pattern}"
							>Access Networks Unleashed setup</a
						>
						<span class="muted">
							— adopt a controller and save auth information
						</span>
					</p>
					<form method="POST">
						<button type="submit">Scan controllers</button>
					</form>
					${renderInfoRows([
						{
							label: 'Worker connection',
							value: input.state.connection.connected
								? 'connected'
								: 'disconnected',
						},
						{
							label: 'Adopted controller',
							value: configStatus.adoptedControllerId ?? 'none',
						},
						{
							label: 'Auth info stored',
							value: configStatus.hasStoredCredentials ? 'yes' : 'no',
						},
						{
							label: 'Known controllers',
							value: controllers.length,
						},
						{
							label: 'Last auth success',
							value: configStatus.lastAuthenticatedAt ?? 'never',
						},
						{
							label: 'Last auth error',
							value: configStatus.lastAuthError ?? 'none',
						},
					])}
				</section>
				${input.scanMessage
					? renderBanner({ tone: 'success', message: input.scanMessage })
					: ''}
				${input.scanError
					? renderBanner({ tone: 'error', message: input.scanError })
					: ''}
				<section class="card">
					<h2>Configuration readiness</h2>
					${renderInfoRows([
						{
							label: 'Configured',
							value: configStatus.configured ? 'yes' : 'no',
						},
						{
							label: 'Missing requirements',
							value:
								configStatus.missingRequirements.length > 0
									? configStatus.missingRequirements.join(', ')
									: 'none',
						},
						{
							label: 'Allow insecure TLS',
							value: configStatus.allowInsecureTls ? 'yes' : 'no',
						},
						{
							label: 'Controller host',
							value: configStatus.host ?? 'none',
						},
					])}
				</section>
				<section class="card">
					<h2>Known controllers</h2>
					${renderAccessNetworksUnleashedControllerList('known', controllers)}
				</section>
				${renderAccessNetworksUnleashedDiscoveryDiagnostics(input.diagnostics)}`,
		}),
	)
}

function renderAccessNetworksUnleashedSetupPage(input: {
	state: HomeConnectorState
	controllers: Array<AccessNetworksUnleashedPublicController>
	configStatus: ReturnType<
		ReturnType<typeof createAccessNetworksUnleashedAdapter>['getConfigStatus']
	>
	diagnostics: AccessNetworksUnleashedDiscoveryDiagnostics | null
	banner: Banner
}) {
	const { controllers, configStatus } = input
	const adoptableControllers = controllers.filter(
		(controller) => !controller.adopted,
	)
	const controllersWithAuth = controllers.filter(
		(controller) => controller.hasStoredCredentials,
	)

	return render(
		RootLayout({
			title: 'home connector - access networks unleashed setup',
			currentPath: routes.accessNetworksUnleashedSetup.pattern,
			body: html`<section class="card">
					<h1>Access Networks Unleashed setup</h1>
					<p class="muted">
						Use the local connector UI to adopt a discovered controller, save
						auth information in the connector database, and verify login without
						exposing credentials back to the browser.
					</p>
					<p>
						<a href="${routes.accessNetworksUnleashedStatus.pattern}"
							>Access Networks Unleashed status</a
						>
						<span class="muted">
							— run scans and inspect controller readiness
						</span>
					</p>
					${renderInfoRows([
						{
							label: 'Connector ID',
							value: input.state.connection.connectorId || 'not registered yet',
						},
						{
							label: 'Adopted controller',
							value: configStatus.adoptedControllerId ?? 'none',
						},
						{
							label: 'Controller host',
							value: configStatus.host ?? 'none',
						},
						{
							label: 'Auth info stored',
							value: configStatus.hasStoredCredentials ? 'yes' : 'no',
						},
						{
							label: 'Missing requirements',
							value:
								configStatus.missingRequirements.length > 0
									? configStatus.missingRequirements.join(', ')
									: 'none',
						},
					])}
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Known controllers</h2>
					${renderAccessNetworksUnleashedControllerList('known', controllers)}
				</section>
				<section class="card">
					<h2>Adopt controller</h2>
					<p class="muted">
						Adoption selects which controller the connector should use for the
						generic
						<code>access_networks_unleashed_request</code> capability.
					</p>
					${adoptableControllers.length === 0
						? renderEmptyState(
								'Every known controller is already adopted, or you need to scan first.',
							)
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="adopt-controller" />
								<label>
									Controller
									<select name="controllerId" required>
										${renderControllerOptions(adoptableControllers)}
									</select>
								</label>
								<div class="form-actions">
									<button type="submit">Adopt controller</button>
								</div>
							</form>`}
				</section>
				<section class="card">
					<h2>Set auth information</h2>
					<p class="muted">
						Username and password are stored locally on this connector using the
						shared secret. The browser never receives the saved secret back.
					</p>
					${controllers.length === 0
						? renderEmptyState(
								'No controllers are known yet. Scan from the status page first.',
							)
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="save-credentials" />
								<label>
									Controller
									<select name="controllerId" required>
										${renderControllerOptions(controllers)}
									</select>
								</label>
								<label>
									Username
									<input
										type="text"
										name="username"
										required
										autocomplete="username"
										placeholder="admin"
									/>
								</label>
								<label>
									Password
									<input
										type="password"
										name="password"
										required
										autocomplete="current-password"
										placeholder="Controller password"
									/>
								</label>
								<div class="form-actions">
									<button type="submit">Save auth information</button>
								</div>
							</form>`}
				</section>
				<section class="card">
					<h2>Authenticate controller</h2>
					<p class="muted">
						Run a live login check using the auth information already stored for
						the selected controller.
					</p>
					${controllersWithAuth.length === 0
						? renderEmptyState(
								'Save auth information for a controller before testing authentication.',
							)
						: html`<form method="POST" class="field-stack">
								<input
									type="hidden"
									name="intent"
									value="authenticate-controller"
								/>
								<label>
									Controller
									<select name="controllerId" required>
										${renderControllerOptions(controllersWithAuth)}
									</select>
								</label>
								<div class="form-actions">
									<button type="submit">Authenticate now</button>
								</div>
							</form>`}
				</section>
				<section class="card">
					<h2>Remove controller</h2>
					<p class="muted">
						Remove a locally stored controller entry and any saved auth
						information for it.
					</p>
					${controllers.length === 0
						? renderEmptyState('No controllers are stored locally.')
						: html`<form method="POST" class="field-stack">
								<input type="hidden" name="intent" value="remove-controller" />
								<label>
									Controller
									<select name="controllerId" required>
										${renderControllerOptions(controllers)}
									</select>
								</label>
								<div class="form-actions">
									<button type="submit">Remove controller</button>
								</div>
							</form>`}
				</section>
				${renderAccessNetworksUnleashedDiscoveryDiagnostics(input.diagnostics)}`,
		}),
	)
}

export function createAccessNetworksUnleashedStatusHandler(
	state: HomeConnectorState,
	accessNetworksUnleashed: ReturnType<
		typeof createAccessNetworksUnleashedAdapter
	>,
) {
	function renderPage(banner?: { scanMessage?: string; scanError?: string }) {
		return renderAccessNetworksUnleashedStatusPage({
			state,
			configStatus: accessNetworksUnleashed.getConfigStatus(),
			controllers: accessNetworksUnleashed.listControllers(),
			diagnostics: accessNetworksUnleashed.getDiscoveryDiagnostics(),
			scanMessage: banner?.scanMessage,
			scanError: banner?.scanError,
		})
	}

	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const controllers = await accessNetworksUnleashed.scan()
					return renderPage({
						scanMessage: `Scan complete. Discovered ${controllers.length} Access Networks Unleashed controller(s).`,
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/access-networks-unleashed/status',
							action: 'scan',
						},
						contexts: {
							accessNetworksUnleashed: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					return renderPage({
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}

			return renderPage()
		},
	} satisfies BuildAction<
		typeof routes.accessNetworksUnleashedStatus.method,
		typeof routes.accessNetworksUnleashedStatus.pattern
	>
}

export function createAccessNetworksUnleashedSetupHandler(
	state: HomeConnectorState,
	accessNetworksUnleashed: ReturnType<
		typeof createAccessNetworksUnleashedAdapter
	>,
) {
	function renderPage(banner: Banner = null) {
		return renderAccessNetworksUnleashedSetupPage({
			state,
			controllers: accessNetworksUnleashed.listControllers(),
			configStatus: accessNetworksUnleashed.getConfigStatus(),
			diagnostics: accessNetworksUnleashed.getDiscoveryDiagnostics(),
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
					const controllerId = String(form.get('controllerId') ?? '').trim()

					if (intent === 'adopt-controller') {
						if (!controllerId) {
							throw new Error('Choose a controller to adopt.')
						}
						const controller = accessNetworksUnleashed.adoptController({
							controllerId,
						})
						return renderPage({
							tone: 'success',
							message: `Adopted Access Networks Unleashed controller ${controller.name}.`,
						})
					}

					if (intent === 'save-credentials') {
						if (!controllerId) {
							throw new Error(
								'Choose a controller before saving auth information.',
							)
						}
						const username = String(form.get('username') ?? '')
						const password = String(form.get('password') ?? '')
						const controller = accessNetworksUnleashed.setCredentials({
							controllerId,
							username,
							password,
						})
						return renderPage({
							tone: 'success',
							message: `Saved auth information for ${controller.name}.`,
						})
					}

					if (intent === 'authenticate-controller') {
						if (!controllerId) {
							throw new Error('Choose a controller to authenticate.')
						}
						const controller =
							await accessNetworksUnleashed.authenticate(controllerId)
						return renderPage({
							tone: 'success',
							message: `Authenticated Access Networks Unleashed controller ${controller.name}.`,
						})
					}

					if (intent === 'remove-controller') {
						if (!controllerId) {
							throw new Error('Choose a controller to remove.')
						}
						const controller = accessNetworksUnleashed.removeController({
							controllerId,
						})
						return renderPage({
							tone: 'success',
							message: `Removed Access Networks Unleashed controller ${controller.name}.`,
						})
					}

					return renderPage({
						tone: 'error',
						message: 'Unknown form action.',
					})
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/access-networks-unleashed/setup',
							action: 'form',
						},
						contexts: {
							accessNetworksUnleashed: {
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
		typeof routes.accessNetworksUnleashedSetup.method,
		typeof routes.accessNetworksUnleashedSetup.pattern
	>
}
