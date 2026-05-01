import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { type createJellyfishAdapter } from '../src/adapters/jellyfish/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import { type HomeConnectorState } from '../src/state.ts'
import { captureHomeConnectorException } from '../src/sentry.ts'
import { renderInfoRows, renderBanner } from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { type routes } from './routes.ts'

function renderJellyfishControllerList(
	controllers: ReturnType<
		ReturnType<typeof createJellyfishAdapter>['listControllers']
	>,
) {
	if (controllers.length === 0) {
		return html`<p class="muted">No JellyFish controllers are known yet.</p>`
	}

	return html`<ul class="list">
		${controllers.map(
			(controller) =>
				html`<li class="card">
					<strong>${controller.name}</strong>
					<div>ID: <code>${controller.controllerId}</code></div>
					<div>Hostname: <code>${controller.hostname}</code></div>
					<div>
						Host: <code>${controller.host}:${String(controller.port)}</code>
					</div>
					<div>Last seen: ${controller.lastSeenAt ?? 'unknown'}</div>
					<div>Last connected: ${controller.lastConnectedAt ?? 'never'}</div>
					<div>Last error: ${controller.lastError ?? 'none'}</div>
				</li>`,
		)}
	</ul>`
}

function renderJellyfishZones(
	zones: Awaited<
		ReturnType<ReturnType<typeof createJellyfishAdapter>['listZones']>
	>['zones'],
	error: string | null,
) {
	if (error) {
		return html`<p class="muted">${error}</p>`
	}
	if (zones.length === 0) {
		return html`<p class="muted">No JellyFish zones were returned.</p>`
	}
	return html`<ul class="list">
		${zones.map(
			(zone) =>
				html`<li class="card">
					<strong>${zone.name}</strong>
					<div>Pixels: ${zone.numPixels ?? 'unknown'}</div>
					<div>Ports mapped: ${zone.portMap.length}</div>
				</li>`,
		)}
	</ul>`
}

function renderJellyfishPatterns(
	patterns: Awaited<
		ReturnType<ReturnType<typeof createJellyfishAdapter>['listPatterns']>
	>['patterns'],
	error: string | null,
) {
	if (error) {
		return html`<p class="muted">${error}</p>`
	}
	if (patterns.length === 0) {
		return html`<p class="muted">No JellyFish patterns were returned.</p>`
	}
	return html`<ul class="list">
		${patterns.map(
			(pattern) =>
				html`<li class="card">
					<strong>${pattern.path}</strong>
					<div>Folder: ${pattern.folder}</div>
					<div>Read only: ${pattern.readOnly ? 'yes' : 'no'}</div>
				</li>`,
		)}
	</ul>`
}

async function loadJellyfishStatusData(
	jellyfish: ReturnType<typeof createJellyfishAdapter>,
) {
	let zones: Array<{
		name: string
		numPixels: number | null
		portMap: Array<Record<string, unknown>>
	}> = []
	let zonesError: string | null = null
	try {
		zones = (await jellyfish.listZones()).zones
	} catch (error) {
		zonesError =
			error instanceof Error
				? error.message
				: `Failed to load zones: ${String(error)}`
	}

	let patterns: Array<{
		path: string
		folder: string
		name: string
		readOnly: boolean
	}> = []
	let patternsError: string | null = null
	try {
		patterns = (await jellyfish.listPatterns()).patterns
	} catch (error) {
		patternsError =
			error instanceof Error
				? error.message
				: `Failed to load patterns: ${String(error)}`
	}

	return {
		status: jellyfish.getStatus(),
		controllers: jellyfish.listControllers(),
		zones,
		zonesError,
		patterns,
		patternsError,
	}
}

function renderJellyfishStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createJellyfishAdapter>['getStatus']>
	controllers: ReturnType<
		ReturnType<typeof createJellyfishAdapter>['listControllers']
	>
	zones: Array<{
		name: string
		numPixels: number | null
		portMap: Array<Record<string, unknown>>
	}>
	zonesError: string | null
	patterns: Array<{
		path: string
		folder: string
		name: string
		readOnly: boolean
	}>
	patternsError: string | null
	banner?: { tone: 'success' | 'error'; message: string } | null
}) {
	return render(
		RootLayout({
			title: 'home connector - jellyfish status',
			body: html`<section class="card">
					<h1>JellyFish status</h1>
					<p class="muted">
						Current discovery and controller state for JellyFish Lighting.
					</p>
					<p>
						<a href="/jellyfish/setup">JellyFish setup</a>
						<span class="muted">
							— connector configuration and scan settings</span
						>
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
							<strong>Known controllers</strong>
							<div>${input.controllers.length}</div>
						</div>
						<div>
							<strong>Known zones</strong>
							<div>${input.zones.length}</div>
						</div>
						<div>
							<strong>Patterns</strong>
							<div>${input.patterns.length}</div>
						</div>
					</div>
				</section>
				${input.banner ? renderBanner(input.banner) : ''}
				<section class="card">
					<h2>Controllers</h2>
					${renderJellyfishControllerList(input.controllers)}
				</section>
				<section class="card">
					<h2>Zones</h2>
					${renderJellyfishZones(input.zones, input.zonesError)}
				</section>
				<section class="card">
					<h2>Patterns</h2>
					${renderJellyfishPatterns(input.patterns, input.patternsError)}
				</section>
				<section class="card">
					<h2>Discovery diagnostics</h2>
					${input.status.diagnostics
						? renderInfoRows([
								{ label: 'Protocol', value: input.status.diagnostics.protocol },
								{
									label: 'Discovery source',
									value: html`<code
										>${input.status.diagnostics.discoveryUrl}</code
									>`,
								},
								{
									label: 'Last scan',
									value: input.status.diagnostics.scannedAt,
								},
							])
						: html`<p class="muted">
								No JellyFish scan diagnostics captured yet.
							</p>`}
				</section>`,
		}),
	)
}

export function createJellyfishStatusHandler(
	state: HomeConnectorState,
	jellyfish: ReturnType<typeof createJellyfishAdapter>,
) {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			let banner: { tone: 'success' | 'error'; message: string } | null = null

			if (request.method === 'POST') {
				try {
					const controllers = await jellyfish.scan()
					banner = {
						tone: 'success',
						message: `Scan complete. Discovered ${controllers.length} JellyFish controller(s).`,
					}
				} catch (error) {
					captureHomeConnectorException(error, {
						tags: {
							route: '/jellyfish/status',
							action: 'scan',
						},
						contexts: {
							jellyfish: {
								connectorId: state.connection.connectorId,
							},
						},
					})
					banner = {
						tone: 'error',
						message:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					}
				}
			}

			const data = await loadJellyfishStatusData(jellyfish)
			return renderJellyfishStatusPage({
				state,
				...data,
				banner,
			})
		},
	} satisfies BuildAction<
		typeof routes.jellyfishStatus.method,
		typeof routes.jellyfishStatus.pattern
	>
}

export function createJellyfishSetupHandler(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
	jellyfish: ReturnType<typeof createJellyfishAdapter>,
) {
	return {
		middleware: [],
		async handler() {
			const status = jellyfish.getStatus()
			return render(
				RootLayout({
					title: 'home connector - jellyfish setup',
					body: html`<section class="card">
						<h1>JellyFish setup</h1>
						<p class="muted">
							Connector configuration and discovery context for JellyFish
							Lighting.
						</p>
						<p>
							<a href="/jellyfish/status">JellyFish status</a>
							<span class="muted"> — scan and inspect live controllers</span>
						</p>
						${renderInfoRows([
							{
								label: 'Connector ID',
								value: html`<code>${state.connection.connectorId}</code>`,
							},
							{
								label: 'Mocks',
								value: state.connection.mocksEnabled ? 'enabled' : 'disabled',
							},
							{
								label: 'Discovery URL override',
								value: config.jellyfishDiscoveryUrl
									? html`<code>${config.jellyfishDiscoveryUrl}</code>`
									: 'none',
							},
							{
								label: 'Scan CIDRs',
								value: html`<code
									>${config.jellyfishScanCidrs.join(', ') || 'none'}</code
								>`,
							},
							{
								label: 'Known controllers',
								value: String(status.controllers.length),
							},
							{
								label: 'Last error',
								value: state.connection.lastError ?? 'none',
							},
						])}
					</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.jellyfishSetup.method,
		typeof routes.jellyfishSetup.pattern
	>
}
