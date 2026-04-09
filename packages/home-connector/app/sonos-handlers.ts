import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import { type createSonosAdapter } from '../src/adapters/sonos/index.ts'
import {
	type SonosDiscoveryDiagnostics,
	type SonosGroup,
} from '../src/adapters/sonos/types.ts'
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

function renderInfoRows(
	rows: Array<{
		label: string
		value: string | number | ReturnType<typeof html>
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

function renderBanner(input: { tone: 'success' | 'error'; message: string }) {
	return html`<section
		class="card ${input.tone === 'error' ? 'card-error' : 'card-success'}"
	>
		<p>${input.message}</p>
	</section>`
}

function renderSonosPlayerList(
	label: string,
	players: Array<{
		playerId: string
		roomName: string
		host: string
		modelName: string | null
		audioInputSupported: boolean
		adopted: boolean
		lastSeenAt: string | null
	}>,
) {
	if (players.length === 0) {
		return html`<p class="muted">No ${label} Sonos players.</p>`
	}
	return html`<ul class="list">
		${players.map(
			(player) =>
				html`<li class="card">
					<strong>${player.roomName}</strong>
					<div>ID: <code>${player.playerId}</code></div>
					<div>Host: <code>${player.host}</code></div>
					<div>Model: ${player.modelName ?? 'unknown'}</div>
					<div>Adopted: ${player.adopted ? 'yes' : 'no'}</div>
					<div>
						Audio input: ${player.audioInputSupported ? 'supported' : 'no'}
					</div>
					<div>Last seen: ${player.lastSeenAt ?? 'unknown'}</div>
				</li>`,
		)}
	</ul>`
}

function renderSonosGroups(groups: Array<SonosGroup>) {
	if (groups.length === 0) {
		return html`<p class="muted">No Sonos groups are currently available.</p>`
	}
	return html`<ul class="list">
		${groups.map(
			(group) =>
				html`<li class="card">
					<div>Group: <code>${group.groupId}</code></div>
					<div>
						Coordinator:
						<code>${group.coordinatorPlayerId ?? group.coordinatorId}</code>
					</div>
					<div>
						Rooms:
						${group.members
							.map(
								(member) =>
									`${member.roomName}${member.coordinator ? ' (coordinator)' : ''}`,
							)
							.join(', ')}
					</div>
				</li>`,
		)}
	</ul>`
}

function renderSonosDiscoveryDiagnostics(
	diagnostics: SonosDiscoveryDiagnostics | null,
) {
	if (!diagnostics) {
		return html`<p class="muted">No Sonos scan diagnostics captured yet.</p>`
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
				{ label: 'SSDP hits', value: diagnostics.ssdpHits.length },
				{
					label: 'Description lookups',
					value: diagnostics.descriptionLookups.length,
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
			<h2>SSDP hits</h2>
			${diagnostics.ssdpHits.length === 0
				? html`<p class="muted">No SSDP hits were captured.</p>`
				: html`<ul class="list">
						${diagnostics.ssdpHits.map(
							(hit) =>
								html`<li class="card">
									<div>
										From:
										<code>${hit.remoteAddress}:${String(hit.remotePort)}</code>
									</div>
									<div>Location: <code>${hit.location ?? 'missing'}</code></div>
									<div>USN: <code>${hit.usn ?? 'missing'}</code></div>
									<div>
										Household:
										<code>${hit.householdId ?? 'unknown'}</code>
									</div>
									${renderCodeBlock(hit.raw)}
								</li>`,
						)}
					</ul>`}
		</section>
		<section class="card">
			<h2>Description lookups</h2>
			${diagnostics.descriptionLookups.length === 0
				? html`<p class="muted">No Sonos device descriptions were captured.</p>`
				: html`<ul class="list">
						${diagnostics.descriptionLookups.map(
							(lookup) =>
								html`<li class="card">
									<div>
										Description URL: <code>${lookup.descriptionUrl}</code>
									</div>
									<div>Host: <code>${lookup.host ?? 'unknown'}</code></div>
									<div>Error: ${lookup.error ?? 'none'}</div>
									${lookup.parsed
										? renderCodeBlock(formatJson(lookup.parsed))
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

function renderSonosStatusPage(input: {
	state: HomeConnectorState
	status: ReturnType<ReturnType<typeof createSonosAdapter>['getStatus']>
	groups: Array<SonosGroup>
	scanMessage?: string | null
	scanError?: string | null
}) {
	return render(
		RootLayout({
			title: 'home connector - sonos status',
			body: html`<section class="card">
					<h1>Sonos status</h1>
					<p class="muted">
						Current discovery, grouping, and connectivity state for Sonos
						players managed by this connector.
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
							<strong>Adopted players</strong>
							<div>${input.status.adopted.length}</div>
						</div>
						<div>
							<strong>Audio input capable</strong>
							<div>${input.status.audioInputSupportedCount}</div>
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
					<h2>Current groups</h2>
					${renderSonosGroups(input.groups)}
				</section>
				<section class="card">
					<h2>Adopted players</h2>
					${renderSonosPlayerList('adopted', input.status.adopted)}
				</section>
				<section class="card">
					<h2>Discovered players</h2>
					${renderSonosPlayerList('discovered', input.status.discovered)}
				</section>
				${renderSonosDiscoveryDiagnostics(
					input.state.sonosDiscoveryDiagnostics,
				)}`,
		}),
	)
}

export function createSonosStatusHandler(
	state: HomeConnectorState,
	sonos: ReturnType<typeof createSonosAdapter>,
) {
	return {
		middleware: [],
		async action({ request }: { request: Request }) {
			if (request.method === 'POST') {
				try {
					const players = await sonos.scan()
					const [status, groups] = await Promise.all([
						sonos.getStatus(),
						sonos.listGroups(),
					])
					return renderSonosStatusPage({
						state,
						status,
						groups,
						scanMessage: `Scan complete. Discovered ${players.length} Sonos player(s).`,
					})
				} catch (error) {
					const status = sonos.getStatus()
					captureHomeConnectorException(error, {
						tags: {
							route: '/sonos/status',
							action: 'scan',
						},
						contexts: {
							sonos: {
								discoveryUrl:
									state.sonosDiscoveryDiagnostics?.discoveryUrl ?? 'unknown',
								connectorId: state.connection.connectorId,
								knownPlayers: status.allPlayers.length,
							},
						},
					})
					const [statusResult, groups] = await Promise.all([
						Promise.resolve(status),
						sonos.listGroups().catch(() => []),
					])
					return renderSonosStatusPage({
						state,
						status: statusResult,
						groups,
						scanError:
							error instanceof Error
								? `Scan failed: ${error.message}`
								: `Scan failed: ${String(error)}`,
					})
				}
			}

			const [status, groups] = await Promise.all([
				sonos.getStatus(),
				sonos.listGroups().catch(() => []),
			])
			return renderSonosStatusPage({
				state,
				status,
				groups,
			})
		},
	} satisfies BuildAction<
		typeof routes.sonosStatus.method,
		typeof routes.sonosStatus.pattern
	>
}

export function createSonosSetupHandler(
	state: HomeConnectorState,
	sonos: ReturnType<typeof createSonosAdapter>,
) {
	return {
		middleware: [],
		async action() {
			const status = sonos.getStatus()
			const diagnostics = [
				`Worker URL: ${state.connection.workerUrl}`,
				`Connector ID: ${state.connection.connectorId}`,
				`Sonos discovery URL: ${state.sonosDiscoveryDiagnostics?.discoveryUrl ?? 'not scanned yet'}`,
				`Known Sonos players: ${String(status.allPlayers.length)}`,
				`Adopted Sonos players: ${String(status.adopted.length)}`,
				`Audio input capable players: ${String(status.audioInputSupportedCount)}`,
				state.connection.mocksEnabled
					? 'Mocks are enabled for this connector instance.'
					: 'Mocks are disabled for this connector instance.',
				state.connection.lastError
					? `Last connector error: ${state.connection.lastError}`
					: 'No connector error recorded.',
			]
			return render(
				RootLayout({
					title: 'home connector - sonos setup',
					body: html`<section class="card">
						<h1>Sonos setup</h1>
						<p class="muted">
							Review connector registration, discovery status, adoption state,
							and local-network diagnostics for Sonos players.
						</p>
						<ul class="list">
							${diagnostics.map((line) => html`<li>${line}</li>`)}
						</ul>
						<p class="muted">
							V1 keeps this page read-only while discovery, adoption, and
							diagnostics flow through the Sonos adapter and MCP tools.
						</p>
					</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.sonosSetup.method,
		typeof routes.sonosSetup.pattern
	>
}
