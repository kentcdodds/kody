import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type createTeslaGatewayAdapter } from '../src/adapters/tesla-gateway/index.ts'
import {
	type TeslaGatewayDiscoveryDiagnostics,
	type TeslaGatewayLiveSnapshot,
	type TeslaGatewayPublicRecord,
} from '../src/adapters/tesla-gateway/types.ts'
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

function validateSameOriginPost(request: Request) {
	const requestOrigin = new URL(request.url).origin
	const origin = request.headers.get('origin')
	if (origin) {
		if (origin === requestOrigin) return
		throw new Response('Forbidden', { status: 403 })
	}
	const referer = request.headers.get('referer')
	if (referer && new URL(referer).origin === requestOrigin) return
	throw new Response('Forbidden', { status: 403 })
}

function summarizeLiveSnapshot(snapshot: TeslaGatewayLiveSnapshot) {
	return {
		gateway: snapshot.gateway,
		status: snapshot.status,
		systemStatus: snapshot.systemStatus,
		gridStatus: snapshot.gridStatus,
		soe: snapshot.soe,
		meters: snapshot.meters,
		operation: snapshot.operation,
		siteInfo: snapshot.siteInfo,
		fetchErrors: snapshot.fetchErrors,
	}
}

async function handleTeslaGatewayMutation(input: {
	action: string
	formData: FormData
	teslaGateway: ReturnType<typeof createTeslaGatewayAdapter>
}) {
	const { action, formData, teslaGateway } = input

	if (action === 'scan') {
		const gateways = await teslaGateway.scan()
		return {
			message: `Scan complete. ${gateways.length} gateway(s) known.`,
			details: null,
		}
	}

	if (action === 'authenticate') {
		const gatewayId = requireStringField(formData, 'gatewayId', 'Gateway')
		const gateway = await teslaGateway.authenticate(gatewayId)
		return {
			message: `Authenticated against ${gateway.host} (${gateway.gatewayId}).`,
			details: null,
		}
	}

	if (action === 'fetch-snapshot') {
		const gatewayId = requireStringField(formData, 'gatewayId', 'Gateway')
		const snapshot = await teslaGateway.getLiveSnapshot(gatewayId)
		const errorCount = Object.keys(snapshot.fetchErrors).length
		return {
			message:
				errorCount === 0
					? `Pulled live snapshot for ${snapshot.gateway.gatewayId}.`
					: `Pulled snapshot for ${snapshot.gateway.gatewayId} with ${errorCount} per-endpoint error(s).`,
			details: summarizeLiveSnapshot(snapshot),
		}
	}

	if (action === 'find-export-limit') {
		const gatewayId = requireStringField(formData, 'gatewayId', 'Gateway')
		const info = await teslaGateway.findExportLimit(gatewayId)
		return {
			message:
				info.exportLimitKw === null
					? `Could not determine an export limit for ${info.gatewayId}.`
					: `${info.gatewayId} export limit ≈ ${info.exportLimitKw} kW (source: ${info.source}).`,
			details: null,
		}
	}

	if (action === 'save-credentials') {
		const gatewayId = requireStringField(formData, 'gatewayId', 'Gateway')
		const password = requireStringField(formData, 'password', 'Password')
		const emailLabel = formData.get('customerEmailLabel')
		const gateway = teslaGateway.setCredentials({
			gatewayId,
			password,
			...(typeof emailLabel === 'string' && emailLabel.trim().length > 0
				? { customerEmailLabel: emailLabel.trim() }
				: {}),
		})
		return {
			message: `Saved credentials for ${gateway.host} (${gateway.gatewayId}).`,
			details: null,
		}
	}

	if (action === 'set-label') {
		const gatewayId = requireStringField(formData, 'gatewayId', 'Gateway')
		const labelInput = formData.get('label')
		const label =
			typeof labelInput === 'string' && labelInput.trim().length > 0
				? labelInput.trim()
				: null
		teslaGateway.setLabel({ gatewayId, label })
		return {
			message: label
				? `Set label for ${gatewayId} to "${label}".`
				: `Cleared label for ${gatewayId}.`,
			details: null,
		}
	}

	throw new Error(`Unknown Tesla gateway action "${action}".`)
}

function renderGatewayList(gateways: Array<TeslaGatewayPublicRecord>) {
	if (gateways.length === 0) {
		return html`<p class="muted">
			No Tesla gateways are currently known. Run a scan from the status page or
			set a static <code>TESLA_GATEWAY_DISCOVERY_URL</code> for mock testing.
		</p>`
	}
	return html`<ul class="list">
		${gateways.map(
			(gateway) => html`<li class="card">
				<strong>${gateway.label ?? gateway.gatewayId}</strong>
				<div>Host: <code>${gateway.host}:${String(gateway.port)}</code></div>
				<div>Gateway ID: <code>${gateway.gatewayId}</code></div>
				<div>DIN: <code>${gateway.din ?? 'unknown'}</code></div>
				<div>Serial: <code>${gateway.serialNumber ?? 'unknown'}</code></div>
				<div>MAC: <code>${gateway.macAddress ?? 'unknown'}</code></div>
				<div>OUI: <code>${gateway.macOui ?? 'unknown'}</code></div>
				<div>Firmware: ${gateway.firmwareVersion ?? 'unknown'}</div>
				<div>Role: ${gateway.role}</div>
				<div>
					Cert subject:
					<code
						>${gateway.cert?.subjectOrganization ?? 'unknown'} /
						${gateway.cert?.subjectOrganizationalUnit ?? 'unknown'}</code
					>
				</div>
				<div>
					Credentials: ${gateway.hasStoredCredentials ? 'stored' : 'missing'}
				</div>
				<div>Last authenticated: ${gateway.lastAuthenticatedAt ?? 'never'}</div>
				${gateway.lastAuthError
					? html`<div>Last auth error: ${gateway.lastAuthError}</div>`
					: ''}
				<form method="POST">
					<input type="hidden" name="action" value="authenticate" />
					<input type="hidden" name="gatewayId" value="${gateway.gatewayId}" />
					<button type="submit">Authenticate</button>
				</form>
				<form method="POST">
					<input type="hidden" name="action" value="fetch-snapshot" />
					<input type="hidden" name="gatewayId" value="${gateway.gatewayId}" />
					<button type="submit">Fetch live snapshot</button>
				</form>
				<form method="POST">
					<input type="hidden" name="action" value="find-export-limit" />
					<input type="hidden" name="gatewayId" value="${gateway.gatewayId}" />
					<button type="submit">Find export limit</button>
				</form>
			</li>`,
		)}
	</ul>`
}

function renderTeslaGatewayDiscoveryDiagnostics(
	diagnostics: TeslaGatewayDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">
			No Tesla gateway scan diagnostics captured yet.
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
				{
					label: 'Hosts probed',
					value: String(diagnostics.subnetProbe?.hostsProbed ?? 0),
				},
				{
					label: 'Tesla matches',
					value: String(diagnostics.subnetProbe?.teslaMatches ?? 0),
				},
				{
					label: 'Leader matches',
					value: String(diagnostics.subnetProbe?.leaderMatches ?? 0),
				},
				{ label: 'Errors', value: String(diagnostics.errors.length) },
			])}
		</section>
		<section class="card">
			<h2>Host probes</h2>
			${diagnostics.hostProbes.length === 0
				? html`<p class="muted">No host probes were captured.</p>`
				: html`<ul class="list">
						${diagnostics.hostProbes.map(
							(probe) => html`<li class="card">
								<div>
									Host: <code>${probe.host}:${String(probe.port)}</code>
								</div>
								<div>TCP open: ${probe.tcpOpen ? 'yes' : 'no'}</div>
								<div>MAC: <code>${probe.macAddress ?? 'unknown'}</code></div>
								<div>OUI: <code>${probe.macOui ?? 'unknown'}</code></div>
								<div>
									Identified as Tesla: ${probe.identifiedAsTesla ? 'yes' : 'no'}
								</div>
								<div>
									Identified as leader:
									${probe.identifiedAsLeader ? 'yes' : 'no'}
								</div>
								${probe.cert
									? html`<div>
											Cert: ${renderCodeBlock(formatJson(probe.cert))}
										</div>`
									: ''}
								${probe.loginEndpointResponse
									? html`<div>
											Login probe:
											${renderCodeBlock(
												formatJson(probe.loginEndpointResponse),
											)}
										</div>`
									: ''}
							</li>`,
						)}
					</ul>`}
		</section>
	`
}

function renderTeslaGatewayPage(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	teslaGateway: ReturnType<typeof createTeslaGatewayAdapter>
	title: string
	includeSetupForm?: boolean
	scanMessage?: string | null
	scanError?: string | null
	resultDetails?: unknown
}) {
	const status = input.teslaGateway.getStatus()
	return render(
		RootLayout({
			title: `home connector - ${input.title}`,
			body: html`<section class="card">
					<h1>Tesla gateway ${input.title}</h1>
					<p class="muted">
						Local-API access to Tesla Backup Gateway 2 leaders. Customer-role
						credentials are stored encrypted with
						<code>HOME_CONNECTOR_SHARED_SECRET</code> and reused as a cookie
						session for ~24h before re-login.
					</p>
					<p>
						<a href="/tesla-gateway/status">Tesla gateway status</a>
						—
						<a href="/tesla-gateway/setup">Tesla gateway setup</a>
					</p>
					<form method="POST">
						<input type="hidden" name="action" value="scan" />
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
							<strong>Configured gateways</strong>
							<div>${status.gateways.length}</div>
						</div>
						<div>
							<strong>Gateways with credentials</strong>
							<div>${status.configuredCredentialsCount}</div>
						</div>
						<div>
							<strong>Scan CIDRs</strong>
							<div>
								<code
									>${input.config.teslaGatewayScanCidrs.join(', ') ||
									'auto-derived'}</code
								>
							</div>
						</div>
					</div>
				</section>
				${input.scanMessage
					? renderBanner({ tone: 'success', message: input.scanMessage })
					: ''}
				${input.scanError
					? renderBanner({ tone: 'error', message: input.scanError })
					: ''}
				${input.resultDetails
					? html`<section class="card">
							<h2>Action result</h2>
							${renderCodeBlock(formatJson(input.resultDetails))}
						</section>`
					: ''}
				<section class="card">
					<h2>Configured gateways</h2>
					${renderGatewayList(status.gateways)}
				</section>
				${input.includeSetupForm
					? html`<section class="card">
								<h2>Save customer credentials</h2>
								<p class="muted">
									Tesla&apos;s local API
									<code>POST /api/login/Basic</code>
									accepts a
									<code>customer</code>
									role login. The
									<code>email</code>
									field is a free-form audit label only — Tesla does not
									validate it against tesla.com. The default password is printed
									on the gateway sticker (BGW2 password). If the installer
									customised it, contact Tesla Energy Customer Support.
								</p>
								<form method="POST">
									<input type="hidden" name="action" value="save-credentials" />
									<label>
										Gateway ID
										<select name="gatewayId" required>
											${status.gateways.map(
												(gateway) =>
													html`<option value="${gateway.gatewayId}">
														${gateway.label ?? gateway.gatewayId}
														(${gateway.host})
													</option>`,
											)}
										</select>
									</label>
									<label>
										Customer email label (optional)
										<input
											type="text"
											name="customerEmailLabel"
											placeholder="kody@local"
										/>
									</label>
									<label>
										Password
										<input
											type="password"
											name="password"
											autocomplete="off"
											required
										/>
									</label>
									<button type="submit">Save credentials</button>
								</form>
							</section>
							<section class="card">
								<h2>Set label</h2>
								<form method="POST">
									<input type="hidden" name="action" value="set-label" />
									<label>
										Gateway ID
										<select name="gatewayId" required>
											${status.gateways.map(
												(gateway) =>
													html`<option value="${gateway.gatewayId}">
														${gateway.gatewayId}
													</option>`,
											)}
										</select>
									</label>
									<label>
										Label
										<input type="text" name="label" placeholder="Home 1" />
									</label>
									<button type="submit">Set label</button>
								</form>
							</section>`
					: ''}
				${renderTeslaGatewayDiscoveryDiagnostics(status.diagnostics)}`,
		}),
	)
}

function buildHandler(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
	teslaGateway: ReturnType<typeof createTeslaGatewayAdapter>
	title: string
	route: 'status' | 'setup'
	includeSetupForm: boolean
}) {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					validateSameOriginPost(request)
					const formData = await readPostedFormData(request, 'scan')
					const action =
						typeof formData.get('action') === 'string'
							? String(formData.get('action'))
							: 'scan'
					const result = await handleTeslaGatewayMutation({
						action,
						formData,
						teslaGateway: input.teslaGateway,
					})
					return renderTeslaGatewayPage({
						state: input.state,
						config: input.config,
						teslaGateway: input.teslaGateway,
						title: input.title,
						includeSetupForm: input.includeSetupForm,
						scanMessage: result.message,
						resultDetails: result.details,
					})
				} catch (error) {
					if (error instanceof Response) return error
					captureHomeConnectorException(error, {
						tags: {
							route: `/tesla-gateway/${input.route}`,
						},
						contexts: {
							teslaGateway: {
								scanCidrs: input.config.teslaGatewayScanCidrs,
								connectorId: input.state.connection.connectorId,
							},
						},
					})
					return renderTeslaGatewayPage({
						state: input.state,
						config: input.config,
						teslaGateway: input.teslaGateway,
						title: input.title,
						includeSetupForm: input.includeSetupForm,
						scanError: error instanceof Error ? error.message : String(error),
					})
				}
			}
			return renderTeslaGatewayPage({
				state: input.state,
				config: input.config,
				teslaGateway: input.teslaGateway,
				title: input.title,
				includeSetupForm: input.includeSetupForm,
			})
		},
	}
}

export function createTeslaGatewayStatusHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	teslaGateway: ReturnType<typeof createTeslaGatewayAdapter>,
) {
	return buildHandler({
		state,
		config,
		teslaGateway,
		title: 'status',
		route: 'status',
		includeSetupForm: false,
	}) satisfies BuildAction<
		typeof routes.teslaGatewayStatus.method,
		typeof routes.teslaGatewayStatus.pattern
	>
}

export function createTeslaGatewaySetupHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	teslaGateway: ReturnType<typeof createTeslaGatewayAdapter>,
) {
	return buildHandler({
		state,
		config,
		teslaGateway,
		title: 'setup',
		route: 'setup',
		includeSetupForm: true,
	}) satisfies BuildAction<
		typeof routes.teslaGatewaySetup.method,
		typeof routes.teslaGatewaySetup.pattern
	>
}
