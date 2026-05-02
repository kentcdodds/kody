import { type BuildAction } from 'remix/fetch-router'
import { html } from 'remix/html-template'
import {
	renderActionCard,
	renderDataTable,
	renderEmptyState,
	renderInlineLinks,
	renderMetricCard,
	renderPageIntro,
	renderStatusBadge,
	renderSummaryCard,
	type StatusTone,
} from './admin-ui.ts'
import { formatJson, renderCodeBlock, renderInfoRows } from './handler-utils.ts'
import { render } from './render.ts'
import { RootLayout } from './root.ts'
import { routes } from './routes.ts'
import { type createBondAdapter } from '../src/adapters/bond/index.ts'
import {
	type IslandRouterConfigStatus,
	type IslandRouterStatus,
} from '../src/adapters/island-router/types.ts'
import { type createIslandRouterAdapter } from '../src/adapters/island-router/index.ts'
import { type createJellyfishAdapter } from '../src/adapters/jellyfish/index.ts'
import { type createLutronAdapter } from '../src/adapters/lutron/index.ts'
import { type createSamsungTvAdapter } from '../src/adapters/samsung-tv/index.ts'
import { type createSonosAdapter } from '../src/adapters/sonos/index.ts'
import { type createVenstarAdapter } from '../src/adapters/venstar/index.ts'
import { type HomeConnectorConfig } from '../src/config.ts'
import {
	getAdoptedRokuDevices,
	getDiscoveredRokuDevices,
	type HomeConnectorState,
} from '../src/state.ts'

type DashboardDependencies = {
	state: HomeConnectorState
	config: HomeConnectorConfig
	lutron: ReturnType<typeof createLutronAdapter>
	samsungTv: ReturnType<typeof createSamsungTvAdapter>
	sonos: ReturnType<typeof createSonosAdapter>
	bond: ReturnType<typeof createBondAdapter>
	islandRouter: ReturnType<typeof createIslandRouterAdapter>
	jellyfish: ReturnType<typeof createJellyfishAdapter>
	venstar: ReturnType<typeof createVenstarAdapter>
}

type DashboardSnapshot = {
	connectionTone: StatusTone
	connectionLabel: string
	connectionIssues: Array<string>
	workerSnapshotUrl: string | null
	roku: {
		adopted: number
		discovered: number
		diagnosticsCaptured: boolean
	}
	lutron: {
		processors: number
		credentials: number
		diagnosticsCaptured: boolean
	}
	sonos: {
		adopted: number
		discovered: number
		audioInputSupported: number
		diagnosticsCaptured: boolean
	}
	samsungTv: {
		adopted: number
		discovered: number
		paired: number
		diagnosticsCaptured: boolean
	}
	bond: {
		adopted: number
		discovered: number
		withToken: number
		diagnosticsCaptured: boolean
	}
	jellyfish: {
		controllers: number
		discovered: number
		diagnosticsCaptured: boolean
	}
	venstar: {
		configured: number
		online: number
		offline: number
		discovered: number
		diagnosticsCaptured: boolean
	}
	islandRouter: {
		config: IslandRouterConfigStatus
		connected: boolean
		interfaceCount: number
		neighborCount: number
		errorCount: number
		versionModel: string | null
		clock: string | null
		tone: StatusTone
		statusLabel: string
		errors: Array<string>
	}
	totals: {
		managedEndpoints: number
		unmanagedDiscoveries: number
		diagnosticSources: number
	}
}

type LoadDashboardSnapshotInput = {
	islandRouterStatus?: IslandRouterStatus
}

function getConnectionTone(state: HomeConnectorState): StatusTone {
	if (!state.connection.connected) return 'bad'
	if (!state.connection.sharedSecret) return 'warn'
	return 'good'
}

function getConnectionLabel(state: HomeConnectorState) {
	if (!state.connection.connected) return 'Disconnected'
	if (!state.connection.sharedSecret) return 'Connected with missing secret'
	return 'Connected'
}

function getConnectionIssues(state: HomeConnectorState) {
	const issues: Array<string> = []
	if (!state.connection.connected) {
		issues.push('Worker connector is not currently connected.')
	}
	if (!state.connection.sharedSecret) {
		issues.push(
			'Shared secret is missing, so authenticated worker sync is degraded.',
		)
	}
	if (state.connection.lastError) {
		issues.push(`Last connector error: ${state.connection.lastError}`)
	}
	return issues
}

function getWorkerSnapshotUrl(state: HomeConnectorState) {
	return state.connection.connectorId
		? `${state.connection.workerUrl}/home/connectors/${encodeURIComponent(state.connection.connectorId)}/snapshot`
		: null
}

function countDiagnosticSources(state: HomeConnectorState) {
	return [
		state.rokuDiscoveryDiagnostics,
		state.lutronDiscoveryDiagnostics,
		state.sonosDiscoveryDiagnostics,
		state.samsungTvDiscoveryDiagnostics,
		state.bondDiscoveryDiagnostics,
		state.jellyfishDiscoveryDiagnostics,
		state.venstarDiscoveryDiagnostics,
	].filter(Boolean).length
}

function getIslandRouterTone(input: {
	configured: boolean
	connected: boolean
	errorCount: number
}) {
	if (!input.configured) return 'warn'
	if (!input.connected || input.errorCount > 0) return 'bad'
	return 'good'
}

function getIslandRouterStatusLabel(input: {
	configured: boolean
	connected: boolean
	errorCount: number
}) {
	if (!input.configured) return 'Needs configuration'
	if (!input.connected) return 'Configured but unreachable'
	if (input.errorCount > 0) return 'Connected with errors'
	return 'Healthy'
}

async function loadDashboardSnapshot(
	deps: DashboardDependencies,
	input: LoadDashboardSnapshotInput = {},
): Promise<DashboardSnapshot> {
	const rokuAdopted = getAdoptedRokuDevices(deps.state)
	const rokuDiscovered = getDiscoveredRokuDevices(deps.state)
	const lutronStatus = deps.lutron.getStatus()
	const samsungStatus = deps.samsungTv.getStatus()
	const sonosStatus = deps.sonos.getStatus()
	const bondStatus = deps.bond.getStatus()
	const jellyfishStatus = deps.jellyfish.getStatus()
	const venstarDiscoveryStatus = deps.venstar.getStatus()
	const [venstarStatus, loadedIslandRouterStatus] = await Promise.all([
		deps.venstar.listThermostatsWithStatus(),
		input.islandRouterStatus
			? Promise.resolve(input.islandRouterStatus)
			: deps.islandRouter.getStatus(),
	])
	const islandRouterStatus = loadedIslandRouterStatus
	const onlineVenstarCount = venstarStatus.filter(
		(thermostat) => thermostat.info != null,
	).length

	const connectionIssues = getConnectionIssues(deps.state)
	const islandRouterTone = getIslandRouterTone({
		configured: islandRouterStatus.config.configured,
		connected: islandRouterStatus.connected,
		errorCount: islandRouterStatus.errors.length,
	})

	return {
		connectionTone: getConnectionTone(deps.state),
		connectionLabel: getConnectionLabel(deps.state),
		connectionIssues,
		workerSnapshotUrl: getWorkerSnapshotUrl(deps.state),
		roku: {
			adopted: rokuAdopted.length,
			discovered: rokuDiscovered.length,
			diagnosticsCaptured: deps.state.rokuDiscoveryDiagnostics != null,
		},
		lutron: {
			processors: lutronStatus.processors.length,
			credentials: lutronStatus.configuredCredentialsCount,
			diagnosticsCaptured: deps.state.lutronDiscoveryDiagnostics != null,
		},
		sonos: {
			adopted: sonosStatus.adopted.length,
			discovered: sonosStatus.discovered.length,
			audioInputSupported: sonosStatus.audioInputSupportedCount,
			diagnosticsCaptured: deps.state.sonosDiscoveryDiagnostics != null,
		},
		samsungTv: {
			adopted: samsungStatus.adopted.length,
			discovered: samsungStatus.discovered.length,
			paired: samsungStatus.pairedCount,
			diagnosticsCaptured: deps.state.samsungTvDiscoveryDiagnostics != null,
		},
		bond: {
			adopted: bondStatus.adopted.length,
			discovered: bondStatus.discovered.length,
			withToken: bondStatus.bridges.filter((bridge) => bridge.hasStoredToken)
				.length,
			diagnosticsCaptured: deps.state.bondDiscoveryDiagnostics != null,
		},
		jellyfish: {
			controllers: jellyfishStatus.controllers.length,
			discovered: jellyfishStatus.discovered.length,
			diagnosticsCaptured: deps.state.jellyfishDiscoveryDiagnostics != null,
		},
		venstar: {
			configured: venstarStatus.length,
			online: onlineVenstarCount,
			offline: venstarStatus.length - onlineVenstarCount,
			discovered: venstarDiscoveryStatus.discovered.length,
			diagnosticsCaptured: deps.state.venstarDiscoveryDiagnostics != null,
		},
		islandRouter: {
			config: islandRouterStatus.config,
			connected: islandRouterStatus.connected,
			interfaceCount: islandRouterStatus.interfaces.length,
			neighborCount: islandRouterStatus.neighbors.length,
			errorCount: islandRouterStatus.errors.length,
			versionModel: islandRouterStatus.router.version?.model ?? null,
			clock: islandRouterStatus.router.clock,
			tone: islandRouterTone,
			statusLabel: getIslandRouterStatusLabel({
				configured: islandRouterStatus.config.configured,
				connected: islandRouterStatus.connected,
				errorCount: islandRouterStatus.errors.length,
			}),
			errors: islandRouterStatus.errors,
		},
		totals: {
			managedEndpoints:
				rokuAdopted.length +
				lutronStatus.processors.length +
				sonosStatus.adopted.length +
				samsungStatus.adopted.length +
				bondStatus.adopted.length +
				jellyfishStatus.controllers.length +
				venstarStatus.length,
			unmanagedDiscoveries:
				rokuDiscovered.length +
				sonosStatus.discovered.length +
				samsungStatus.discovered.length +
				bondStatus.discovered.length +
				jellyfishStatus.discovered.length +
				venstarDiscoveryStatus.discovered.length,
			diagnosticSources: countDiagnosticSources(deps.state),
		},
	}
}

function getIntegrationTone(input: {
	managedCount: number
	discoveredCount: number
	diagnosticsCaptured: boolean
	optionalIssueCount?: number
}) {
	const issueCount = input.optionalIssueCount ?? 0
	if (issueCount > 0) return 'bad'
	if (input.managedCount > 0) return 'good'
	if (input.discoveredCount > 0 || input.diagnosticsCaptured) return 'warn'
	return 'neutral'
}

function getIntegrationStatusLabel(input: {
	managedCount: number
	discoveredCount: number
	diagnosticsCaptured: boolean
	managedLabel: string
}) {
	if (input.managedCount > 0)
		return `${input.managedCount} ${input.managedLabel}`
	if (input.discoveredCount > 0) return `${input.discoveredCount} discovered`
	if (input.diagnosticsCaptured) return 'Scanned recently'
	return 'No recent data'
}

function renderConnectionSummary(
	state: HomeConnectorState,
	snapshot: DashboardSnapshot,
) {
	return renderSummaryCard({
		title: 'Connector session',
		description:
			'Worker connectivity, identity, sync timing, and shared secret readiness.',
		status: snapshot.connectionLabel,
		tone: snapshot.connectionTone,
		metrics: [
			{
				label: 'Connector ID',
				value: state.connection.connectorId || 'not registered',
			},
			{
				label: 'Last sync',
				value: state.connection.lastSyncAt ?? 'never',
			},
			{
				label: 'Mocks',
				value: state.connection.mocksEnabled ? 'enabled' : 'disabled',
			},
		],
		primaryLink: {
			href: routes.systemStatus.pattern,
			label: 'Open system status',
		},
		secondaryLink: snapshot.workerSnapshotUrl
			? {
					href: snapshot.workerSnapshotUrl,
					label: 'Worker snapshot',
				}
			: undefined,
		note:
			snapshot.connectionIssues.length > 0
				? html`<ul class="compact-list">
						${snapshot.connectionIssues.map((issue) => html`<li>${issue}</li>`)}
					</ul>`
				: 'Connection prerequisites look healthy from the local connector state.',
	})
}

function renderIntegrationSummaryCards(snapshot: DashboardSnapshot) {
	return html`<div class="card-grid">
		${renderSummaryCard({
			title: 'Roku',
			description: 'Streaming device discovery and adoption.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.roku.adopted,
				discoveredCount: snapshot.roku.discovered,
				diagnosticsCaptured: snapshot.roku.diagnosticsCaptured,
				managedLabel: 'adopted',
			}),
			tone: getIntegrationTone({
				managedCount: snapshot.roku.adopted,
				discoveredCount: snapshot.roku.discovered,
				diagnosticsCaptured: snapshot.roku.diagnosticsCaptured,
			}),
			metrics: [
				{ label: 'Adopted', value: snapshot.roku.adopted },
				{ label: 'Discovered', value: snapshot.roku.discovered },
				{
					label: 'Diagnostics',
					value: snapshot.roku.diagnosticsCaptured ? 'captured' : 'none',
				},
			],
			primaryLink: {
				href: routes.rokuStatus.pattern,
				label: 'Roku status',
			},
			secondaryLink: {
				href: routes.rokuSetup.pattern,
				label: 'Roku setup',
			},
		})}
		${renderSummaryCard({
			title: 'Lutron',
			description: 'Processor discovery and credential attachment.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.lutron.processors,
				discoveredCount: 0,
				diagnosticsCaptured: snapshot.lutron.diagnosticsCaptured,
				managedLabel: 'processors',
			}),
			tone:
				snapshot.lutron.processors > 0 && snapshot.lutron.credentials === 0
					? 'warn'
					: getIntegrationTone({
							managedCount: snapshot.lutron.processors,
							discoveredCount: 0,
							diagnosticsCaptured: snapshot.lutron.diagnosticsCaptured,
						}),
			metrics: [
				{ label: 'Processors', value: snapshot.lutron.processors },
				{ label: 'Credentials', value: snapshot.lutron.credentials },
				{
					label: 'Diagnostics',
					value: snapshot.lutron.diagnosticsCaptured ? 'captured' : 'none',
				},
			],
			primaryLink: {
				href: routes.lutronStatus.pattern,
				label: 'Lutron status',
			},
			secondaryLink: {
				href: routes.lutronSetup.pattern,
				label: 'Lutron setup',
			},
		})}
		${renderSummaryCard({
			title: 'Sonos',
			description: 'Grouped players, input support, and adoption.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.sonos.adopted,
				discoveredCount: snapshot.sonos.discovered,
				diagnosticsCaptured: snapshot.sonos.diagnosticsCaptured,
				managedLabel: 'adopted',
			}),
			tone: getIntegrationTone({
				managedCount: snapshot.sonos.adopted,
				discoveredCount: snapshot.sonos.discovered,
				diagnosticsCaptured: snapshot.sonos.diagnosticsCaptured,
			}),
			metrics: [
				{ label: 'Adopted', value: snapshot.sonos.adopted },
				{ label: 'Discovered', value: snapshot.sonos.discovered },
				{ label: 'Audio input', value: snapshot.sonos.audioInputSupported },
			],
			primaryLink: {
				href: routes.sonosStatus.pattern,
				label: 'Sonos status',
			},
			secondaryLink: {
				href: routes.sonosSetup.pattern,
				label: 'Sonos setup',
			},
		})}
		${renderSummaryCard({
			title: 'Samsung TV',
			description: 'Discovery, pairing, and adoption of TVs.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.samsungTv.adopted,
				discoveredCount: snapshot.samsungTv.discovered,
				diagnosticsCaptured: snapshot.samsungTv.diagnosticsCaptured,
				managedLabel: 'adopted',
			}),
			tone:
				snapshot.samsungTv.adopted > 0 && snapshot.samsungTv.paired === 0
					? 'warn'
					: getIntegrationTone({
							managedCount: snapshot.samsungTv.adopted,
							discoveredCount: snapshot.samsungTv.discovered,
							diagnosticsCaptured: snapshot.samsungTv.diagnosticsCaptured,
						}),
			metrics: [
				{ label: 'Adopted', value: snapshot.samsungTv.adopted },
				{ label: 'Discovered', value: snapshot.samsungTv.discovered },
				{ label: 'Paired', value: snapshot.samsungTv.paired },
			],
			primaryLink: {
				href: routes.samsungTvStatus.pattern,
				label: 'Samsung TV status',
			},
			secondaryLink: {
				href: routes.samsungTvSetup.pattern,
				label: 'Samsung TV setup',
			},
		})}
		${renderSummaryCard({
			title: 'Bond',
			description: 'Bridge adoption and token availability.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.bond.adopted,
				discoveredCount: snapshot.bond.discovered,
				diagnosticsCaptured: snapshot.bond.diagnosticsCaptured,
				managedLabel: 'adopted',
			}),
			tone:
				snapshot.bond.adopted > 0 && snapshot.bond.withToken === 0
					? 'warn'
					: getIntegrationTone({
							managedCount: snapshot.bond.adopted,
							discoveredCount: snapshot.bond.discovered,
							diagnosticsCaptured: snapshot.bond.diagnosticsCaptured,
						}),
			metrics: [
				{ label: 'Adopted', value: snapshot.bond.adopted },
				{ label: 'Discovered', value: snapshot.bond.discovered },
				{ label: 'With token', value: snapshot.bond.withToken },
			],
			primaryLink: {
				href: routes.bondStatus.pattern,
				label: 'Bond status',
			},
			secondaryLink: {
				href: routes.bondSetup.pattern,
				label: 'Bond setup',
			},
		})}
		${renderSummaryCard({
			title: 'JellyFish',
			description: 'Lighting controllers, zones, and patterns.',
			status: getIntegrationStatusLabel({
				managedCount: snapshot.jellyfish.controllers,
				discoveredCount: snapshot.jellyfish.discovered,
				diagnosticsCaptured: snapshot.jellyfish.diagnosticsCaptured,
				managedLabel: 'controllers',
			}),
			tone: getIntegrationTone({
				managedCount: snapshot.jellyfish.controllers,
				discoveredCount: snapshot.jellyfish.discovered,
				diagnosticsCaptured: snapshot.jellyfish.diagnosticsCaptured,
			}),
			metrics: [
				{ label: 'Controllers', value: snapshot.jellyfish.controllers },
				{ label: 'Discovered', value: snapshot.jellyfish.discovered },
				{
					label: 'Diagnostics',
					value: snapshot.jellyfish.diagnosticsCaptured ? 'captured' : 'none',
				},
			],
			primaryLink: {
				href: routes.jellyfishStatus.pattern,
				label: 'JellyFish status',
			},
			secondaryLink: {
				href: routes.jellyfishSetup.pattern,
				label: 'JellyFish setup',
			},
		})}
		${renderSummaryCard({
			title: 'Venstar',
			description: 'Managed thermostats with online and offline state.',
			status:
				snapshot.venstar.configured > 0
					? `${snapshot.venstar.online}/${snapshot.venstar.configured} online`
					: snapshot.venstar.discovered > 0
						? `${snapshot.venstar.discovered} discovered`
						: 'No recent data',
			tone:
				snapshot.venstar.configured > 0 && snapshot.venstar.offline > 0
					? 'warn'
					: getIntegrationTone({
							managedCount: snapshot.venstar.configured,
							discoveredCount: snapshot.venstar.discovered,
							diagnosticsCaptured: snapshot.venstar.diagnosticsCaptured,
						}),
			metrics: [
				{ label: 'Configured', value: snapshot.venstar.configured },
				{ label: 'Online', value: snapshot.venstar.online },
				{ label: 'Discovered', value: snapshot.venstar.discovered },
			],
			primaryLink: {
				href: routes.venstarStatus.pattern,
				label: 'Venstar status',
			},
			secondaryLink: {
				href: routes.venstarSetup.pattern,
				label: 'Venstar setup',
			},
		})}
	</div>`
}

function renderDrillDownActions(snapshot: DashboardSnapshot) {
	return html`<div class="action-grid">
		${renderActionCard({
			href: routes.systemStatus.pattern,
			title: 'System status',
			description:
				'See worker URLs, connector identity, environment-derived configuration, and aggregate counts in one place.',
			badge: {
				label: snapshot.connectionLabel,
				tone: snapshot.connectionTone,
			},
		})}
		${renderActionCard({
			href: routes.diagnostics.pattern,
			title: 'Diagnostics',
			description:
				'Review discovery recency, configuration gaps, error banners, and JSON payload access paths.',
			badge: {
				label:
					snapshot.totals.diagnosticSources > 0
						? `${snapshot.totals.diagnosticSources} sources`
						: 'No captures',
				tone: snapshot.totals.diagnosticSources > 0 ? 'good' : 'neutral',
			},
		})}
		${renderActionCard({
			href: routes.islandRouterStatus.pattern,
			title: 'Island router diagnostics',
			description:
				'Inspect SSH configuration readiness, live status, interfaces, neighbor cache, and host-level router diagnosis.',
			badge: {
				label: snapshot.islandRouter.statusLabel,
				tone: snapshot.islandRouter.tone,
			},
		})}
	</div>`
}

function renderDiagnosticsHighlights(snapshot: DashboardSnapshot) {
	const highlights: Array<{ label: string; tone: StatusTone; detail: string }> =
		[]

	if (snapshot.connectionIssues.length > 0) {
		highlights.push({
			label: 'Connector issues',
			tone: snapshot.connectionTone,
			detail: snapshot.connectionIssues[0] ?? 'Connector issues detected.',
		})
	}
	if (!snapshot.islandRouter.config.configured) {
		highlights.push({
			label: 'Island router configuration',
			tone: 'warn',
			detail:
				snapshot.islandRouter.config.missingFields.length > 0
					? `Missing ${snapshot.islandRouter.config.missingFields.join(', ')}`
					: (snapshot.islandRouter.config.warnings[0] ??
						'Island router diagnostics need configuration.'),
		})
	}
	if (snapshot.islandRouter.errors.length > 0) {
		highlights.push({
			label: 'Island router errors',
			tone: 'bad',
			detail: snapshot.islandRouter.errors[0] ?? 'Router errors present.',
		})
	}
	if (snapshot.bond.adopted > snapshot.bond.withToken) {
		highlights.push({
			label: 'Bond tokens',
			tone: 'warn',
			detail: `${snapshot.bond.adopted - snapshot.bond.withToken} adopted bridge(s) still need stored tokens.`,
		})
	}
	if (snapshot.samsungTv.adopted > snapshot.samsungTv.paired) {
		highlights.push({
			label: 'Samsung pairing',
			tone: 'warn',
			detail: `${snapshot.samsungTv.adopted - snapshot.samsungTv.paired} adopted TV(s) are not paired yet.`,
		})
	}
	if (snapshot.venstar.offline > 0) {
		highlights.push({
			label: 'Venstar reachability',
			tone: 'warn',
			detail: `${snapshot.venstar.offline} configured thermostat(s) are currently offline.`,
		})
	}

	if (highlights.length === 0) {
		return renderEmptyState(
			'No high-priority warnings surfaced from the current connector and integration snapshots.',
		)
	}

	return html`<div class="metric-grid">
		${highlights.map((item) =>
			renderMetricCard({
				label: item.label,
				value: renderStatusBadge({
					label: item.tone === 'bad' ? 'attention' : 'review',
					tone: item.tone,
				}),
				detail: item.detail,
				tone: item.tone,
			}),
		)}
	</div>`
}

export function createDashboardHandler(deps: DashboardDependencies) {
	return {
		middleware: [],
		async handler() {
			const snapshot = await loadDashboardSnapshot(deps)
			return render(
				RootLayout({
					title: 'home connector - dashboard',
					currentPath: routes.home.pattern,
					body: html`${renderPageIntro({
							eyebrow: 'Dashboard',
							title: 'Home connector dashboard',
							description:
								'Quick-look operational view for the local admin UI with health, counts, status colors, and direct links into deeper diagnostics.',
							actions: [
								{ href: routes.systemStatus.pattern, label: 'System status' },
								{ href: routes.diagnostics.pattern, label: 'Diagnostics' },
								{
									href: routes.islandRouterStatus.pattern,
									label: 'Island router',
								},
							],
						})}
						<div class="metric-grid">
							${renderMetricCard({
								label: 'Managed endpoints',
								value: snapshot.totals.managedEndpoints,
								detail:
									'Adopted or configured devices/controllers managed by this connector.',
								tone: snapshot.totals.managedEndpoints > 0 ? 'good' : 'neutral',
							})}
							${renderMetricCard({
								label: 'Unmanaged discoveries',
								value: snapshot.totals.unmanagedDiscoveries,
								detail:
									'Devices found on the network that still need adoption or setup.',
								tone:
									snapshot.totals.unmanagedDiscoveries > 0 ? 'warn' : 'good',
							})}
							${renderMetricCard({
								label: 'Diagnostic sources',
								value: snapshot.totals.diagnosticSources,
								detail:
									'Integrations with captured discovery diagnostics in local state.',
								tone:
									snapshot.totals.diagnosticSources > 0 ? 'good' : 'neutral',
							})}
							${renderMetricCard({
								label: 'Router quick look',
								value: snapshot.islandRouter.statusLabel,
								detail:
									snapshot.islandRouter.versionModel ??
									'Island router model not available yet.',
								tone: snapshot.islandRouter.tone,
							})}
						</div>
						${renderConnectionSummary(deps.state, snapshot)}
						<section class="section-stack">
							<div class="card-heading">
								<h2>Integration quick look</h2>
								<p class="muted">
									Green means managed and healthy, yellow means partial setup or
									discoveries, red means a current problem.
								</p>
							</div>
							${renderIntegrationSummaryCards(snapshot)}
						</section>
						<section class="section-stack">
							<div class="card-heading">
								<h2>Drill-down pages</h2>
								<p class="muted">
									Use these admin pages for deeper context instead of jumping
									through a bare list of links.
								</p>
							</div>
							${renderDrillDownActions(snapshot)}
						</section>
						<section class="card">
							<div class="card-heading">
								<h2>Priority diagnostics</h2>
								<p class="muted">
									Highlights from the current state that are likely to need
									action first.
								</p>
							</div>
							${renderDiagnosticsHighlights(snapshot)}
						</section>`,
				}),
			)
		},
	} satisfies BuildAction<typeof routes.home.method, typeof routes.home.pattern>
}

function renderConfigWarningList(configStatus: IslandRouterConfigStatus) {
	if (
		configStatus.missingFields.length === 0 &&
		configStatus.warnings.length === 0
	) {
		return renderEmptyState(
			'No Island router configuration warnings are currently present.',
		)
	}

	return html`<ul class="list">
		${configStatus.missingFields.map(
			(field) => html`<li>Missing ${field}</li>`,
		)}
		${configStatus.warnings.map((warning) => html`<li>${warning}</li>`)}
	</ul>`
}

export function createSystemStatusHandler(deps: DashboardDependencies) {
	return {
		middleware: [],
		async handler() {
			const snapshot = await loadDashboardSnapshot(deps)
			return render(
				RootLayout({
					title: 'home connector - system status',
					currentPath: routes.systemStatus.pattern,
					body: html`${renderPageIntro({
							eyebrow: 'System',
							title: 'System status',
							description:
								'High-level connector identity, network endpoints, environment-derived configuration, and aggregated inventory counts.',
							actions: [
								{ href: routes.home.pattern, label: 'Back to dashboard' },
								{ href: routes.diagnostics.pattern, label: 'Diagnostics' },
							],
						})}
						<div class="metric-grid">
							${renderMetricCard({
								label: 'Connection',
								value: snapshot.connectionLabel,
								detail: deps.state.connection.lastSyncAt ?? 'No sync yet',
								tone: snapshot.connectionTone,
							})}
							${renderMetricCard({
								label: 'Worker secret',
								value: deps.state.connection.sharedSecret
									? 'configured'
									: 'missing',
								detail: 'Used for authenticated worker connector traffic.',
								tone: deps.state.connection.sharedSecret ? 'good' : 'warn',
							})}
							${renderMetricCard({
								label: 'Mocks',
								value: deps.state.connection.mocksEnabled
									? 'enabled'
									: 'disabled',
								detail: deps.state.connection.mocksEnabled
									? 'Local mock services are active.'
									: 'Using live discovery and device endpoints.',
								tone: deps.state.connection.mocksEnabled ? 'warn' : 'neutral',
							})}
							${renderMetricCard({
								label: 'Admin port',
								value: deps.config.port,
								detail: 'Local HTTP server port for this admin UI.',
								tone: 'neutral',
							})}
						</div>
						<section class="card-grid">
							<section class="card">
								<div class="card-heading">
									<h2>Connector identity</h2>
									${renderStatusBadge({
										label: snapshot.connectionLabel,
										tone: snapshot.connectionTone,
									})}
								</div>
								${renderInfoRows([
									{
										label: 'Connector ID',
										value: html`<code
											>${deps.state.connection.connectorId ||
											'not registered'}</code
										>`,
									},
									{
										label: 'Worker URL',
										value: html`<code
											>${deps.state.connection.workerUrl}</code
										>`,
									},
									{
										label: 'Worker session URL',
										value: html`<code>${deps.config.workerSessionUrl}</code>`,
									},
									{
										label: 'Worker WebSocket URL',
										value: html`<code>${deps.config.workerWebSocketUrl}</code>`,
									},
									{
										label: 'Data path',
										value: html`<code>${deps.config.dataPath}</code>`,
									},
									{
										label: 'SQLite DB',
										value: html`<code>${deps.config.dbPath}</code>`,
									},
									{
										label: 'Last connector error',
										value: deps.state.connection.lastError ?? 'none',
									},
								])}
							</section>
							<section class="card">
								<div class="card-heading">
									<h2>Inventory totals</h2>
									<p class="muted">Cross-integration device counts.</p>
								</div>
								${renderInfoRows([
									{
										label: 'Managed endpoints',
										value: String(snapshot.totals.managedEndpoints),
									},
									{
										label: 'Unmanaged discoveries',
										value: String(snapshot.totals.unmanagedDiscoveries),
									},
									{
										label: 'Discovery captures',
										value: String(snapshot.totals.diagnosticSources),
									},
									{
										label: 'Venstar scan CIDRs',
										value: html`<code
											>${deps.config.venstarScanCidrs.join(', ') ||
											'none'}</code
										>`,
									},
									{
										label: 'JellyFish scan CIDRs',
										value: html`<code
											>${deps.config.jellyfishScanCidrs.join(', ') ||
											'none'}</code
										>`,
									},
								])}
							</section>
						</section>
						<section class="card-grid">
							<section class="card">
								<div class="card-heading">
									<h2>Discovery endpoints</h2>
									<p class="muted">
										Configured discovery sources for each integration.
									</p>
								</div>
								${renderInfoRows([
									{
										label: 'Roku',
										value: html`<code>${deps.config.rokuDiscoveryUrl}</code>`,
									},
									{
										label: 'Lutron',
										value: html`<code>${deps.config.lutronDiscoveryUrl}</code>`,
									},
									{
										label: 'Sonos',
										value: html`<code>${deps.config.sonosDiscoveryUrl}</code>`,
									},
									{
										label: 'Samsung TV',
										value: html`<code
											>${deps.config.samsungTvDiscoveryUrl}</code
										>`,
									},
									{
										label: 'Bond',
										value: html`<code>${deps.config.bondDiscoveryUrl}</code>`,
									},
									{
										label: 'JellyFish override',
										value: deps.config.jellyfishDiscoveryUrl
											? html`<code>${deps.config.jellyfishDiscoveryUrl}</code>`
											: 'none',
									},
								])}
							</section>
							<section class="card">
								<div class="card-heading">
									<h2>Island router readiness</h2>
									${renderStatusBadge({
										label: snapshot.islandRouter.statusLabel,
										tone: snapshot.islandRouter.tone,
									})}
								</div>
								${renderInfoRows([
									{
										label: 'Host',
										value: deps.config.islandRouterHost
											? html`<code>${deps.config.islandRouterHost}</code>`
											: 'missing',
									},
									{
										label: 'Port',
										value: String(deps.config.islandRouterPort),
									},
									{
										label: 'Username',
										value: deps.config.islandRouterUsername ?? 'missing',
									},
									{
										label: 'Verification mode',
										value: snapshot.islandRouter.config.verificationMode,
									},
									{
										label: 'Timeout',
										value: `${deps.config.islandRouterCommandTimeoutMs}ms`,
									},
								])}
								${renderConfigWarningList(snapshot.islandRouter.config)}
							</section>
						</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.systemStatus.method,
		typeof routes.systemStatus.pattern
	>
}

type DiagnosticRow = {
	name: string
	status: string
	tone: StatusTone
	details: string
	links: Array<{ href: string; label: string }>
}

function renderDiagnosticRows(rows: Array<DiagnosticRow>) {
	return renderDataTable({
		headers: ['Surface', 'Status', 'Details', 'Links'],
		rows: rows.map((row) => [
			row.name,
			renderStatusBadge({ label: row.status, tone: row.tone }),
			row.details,
			renderInlineLinks(row.links),
		]),
	})
}

export function createDiagnosticsHandler(deps: DashboardDependencies) {
	return {
		middleware: [],
		async handler() {
			const snapshot = await loadDashboardSnapshot(deps)
			const rows: Array<DiagnosticRow> = [
				{
					name: 'Connector session',
					status: snapshot.connectionLabel,
					tone: snapshot.connectionTone,
					details:
						snapshot.connectionIssues[0] ??
						'Worker URL, shared secret, and connector identity look consistent.',
					links: [
						{ href: routes.systemStatus.pattern, label: 'System status' },
						{ href: routes.health.pattern, label: 'Health JSON' },
					],
				},
				{
					name: 'Island router',
					status: snapshot.islandRouter.statusLabel,
					tone: snapshot.islandRouter.tone,
					details:
						snapshot.islandRouter.errors[0] ??
						snapshot.islandRouter.config.warnings[0] ??
						`${snapshot.islandRouter.interfaceCount} interfaces, ${snapshot.islandRouter.neighborCount} neighbors.`,
					links: [
						{
							href: routes.islandRouterStatus.pattern,
							label: 'Router status',
						},
						{
							href: `${routes.islandRouterStatus.pattern}?host=192.168.1.10`,
							label: 'Host diagnosis example',
						},
					],
				},
				{
					name: 'Roku discovery',
					status: snapshot.roku.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: snapshot.roku.diagnosticsCaptured
						? snapshot.roku.discovered > 0
							? 'warn'
							: 'good'
						: 'neutral',
					details: deps.state.rokuDiscoveryDiagnostics
						? `Last scan ${deps.state.rokuDiscoveryDiagnostics.scannedAt} with ${deps.state.rokuDiscoveryDiagnostics.ssdpHits.length} SSDP hits.`
						: 'No Roku scan diagnostics captured yet.',
					links: [
						{ href: routes.rokuStatus.pattern, label: 'Roku status' },
						{ href: routes.rokuSetup.pattern, label: 'Roku setup' },
					],
				},
				{
					name: 'Lutron discovery',
					status: snapshot.lutron.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: deps.state.lutronDiscoveryDiagnostics?.errors.length
						? 'bad'
						: snapshot.lutron.diagnosticsCaptured
							? 'good'
							: 'neutral',
					details: deps.state.lutronDiscoveryDiagnostics
						? `Last scan ${deps.state.lutronDiscoveryDiagnostics.scannedAt} with ${deps.state.lutronDiscoveryDiagnostics.services.length} services and ${deps.state.lutronDiscoveryDiagnostics.errors.length} error(s).`
						: 'No Lutron scan diagnostics captured yet.',
					links: [
						{ href: routes.lutronStatus.pattern, label: 'Lutron status' },
						{ href: routes.lutronSetup.pattern, label: 'Lutron setup' },
					],
				},
				{
					name: 'Sonos discovery',
					status: snapshot.sonos.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: snapshot.sonos.diagnosticsCaptured ? 'good' : 'neutral',
					details: deps.state.sonosDiscoveryDiagnostics
						? `Last scan ${deps.state.sonosDiscoveryDiagnostics.scannedAt} with ${deps.state.sonosDiscoveryDiagnostics.ssdpHits.length} SSDP hits and ${deps.state.sonosDiscoveryDiagnostics.descriptionLookups.length} description lookups.`
						: 'No Sonos diagnostics captured yet.',
					links: [
						{ href: routes.sonosStatus.pattern, label: 'Sonos status' },
						{ href: routes.sonosSetup.pattern, label: 'Sonos setup' },
					],
				},
				{
					name: 'Samsung TV discovery',
					status: snapshot.samsungTv.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: snapshot.samsungTv.diagnosticsCaptured ? 'good' : 'neutral',
					details: deps.state.samsungTvDiscoveryDiagnostics
						? `Last scan ${deps.state.samsungTvDiscoveryDiagnostics.scannedAt} with ${deps.state.samsungTvDiscoveryDiagnostics.services.length} services and ${deps.state.samsungTvDiscoveryDiagnostics.metadataLookups.length} metadata lookups.`
						: 'No Samsung TV diagnostics captured yet.',
					links: [
						{
							href: routes.samsungTvStatus.pattern,
							label: 'Samsung TV status',
						},
						{
							href: routes.samsungTvSetup.pattern,
							label: 'Samsung TV setup',
						},
					],
				},
				{
					name: 'Bond discovery',
					status: snapshot.bond.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: deps.state.bondDiscoveryDiagnostics?.errors.length
						? 'bad'
						: snapshot.bond.diagnosticsCaptured
							? 'good'
							: 'neutral',
					details: deps.state.bondDiscoveryDiagnostics
						? `Last scan ${deps.state.bondDiscoveryDiagnostics.scannedAt} with ${deps.state.bondDiscoveryDiagnostics.services.length} services and ${deps.state.bondDiscoveryDiagnostics.errors.length} error(s).`
						: 'No Bond diagnostics captured yet.',
					links: [
						{ href: routes.bondStatus.pattern, label: 'Bond status' },
						{ href: routes.bondSetup.pattern, label: 'Bond setup' },
					],
				},
				{
					name: 'JellyFish discovery',
					status: snapshot.jellyfish.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone: snapshot.jellyfish.diagnosticsCaptured ? 'good' : 'neutral',
					details: deps.state.jellyfishDiscoveryDiagnostics
						? `Last scan ${deps.state.jellyfishDiscoveryDiagnostics.scannedAt} via ${deps.state.jellyfishDiscoveryDiagnostics.protocol} with ${deps.state.jellyfishDiscoveryDiagnostics.probeResults.length} probe result(s).`
						: 'No JellyFish diagnostics captured yet.',
					links: [
						{
							href: routes.jellyfishStatus.pattern,
							label: 'JellyFish status',
						},
						{
							href: routes.jellyfishSetup.pattern,
							label: 'JellyFish setup',
						},
					],
				},
				{
					name: 'Venstar discovery',
					status: snapshot.venstar.diagnosticsCaptured
						? 'Captured'
						: 'No captures',
					tone:
						snapshot.venstar.offline > 0
							? 'warn'
							: snapshot.venstar.diagnosticsCaptured ||
								  snapshot.venstar.configured > 0
								? 'good'
								: 'neutral',
					details: deps.state.venstarDiscoveryDiagnostics
						? `Last scan ${deps.state.venstarDiscoveryDiagnostics.scannedAt} with ${deps.state.venstarDiscoveryDiagnostics.infoLookups.length} info lookup(s).`
						: 'No Venstar diagnostics captured yet.',
					links: [
						{ href: routes.venstarStatus.pattern, label: 'Venstar status' },
						{ href: routes.venstarSetup.pattern, label: 'Venstar setup' },
					],
				},
			]

			return render(
				RootLayout({
					title: 'home connector - diagnostics',
					currentPath: routes.diagnostics.pattern,
					body: html`${renderPageIntro({
							eyebrow: 'Diagnostics',
							title: 'Diagnostics overview',
							description:
								'Cross-cutting visibility into discovery recency, configuration gaps, and where to drill in for live operational data.',
							actions: [
								{ href: routes.home.pattern, label: 'Dashboard' },
								{
									href: routes.islandRouterStatus.pattern,
									label: 'Island router',
								},
							],
						})}
						<section class="card">
							<div class="card-heading">
								<h2>Diagnostics matrix</h2>
								<p class="muted">
									Every row links back to the local status/setup pages that own
									the underlying details.
								</p>
							</div>
							${renderDiagnosticRows(rows)}
						</section>
						<section class="card-grid">
							<section class="card">
								<div class="card-heading">
									<h2>Connection raw snapshot</h2>
									<p class="muted">Current in-memory connector state.</p>
								</div>
								${renderCodeBlock(formatJson(deps.state.connection))}
							</section>
							<section class="card">
								<div class="card-heading">
									<h2>Known discovery fields</h2>
									<p class="muted">
										Quick way to confirm which diagnostics collections are
										populated.
									</p>
								</div>
								${renderInfoRows([
									{
										label: 'Roku',
										value: deps.state.rokuDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'Lutron',
										value: deps.state.lutronDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'Sonos',
										value: deps.state.sonosDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'Samsung TV',
										value: deps.state.samsungTvDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'Bond',
										value: deps.state.bondDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'JellyFish',
										value: deps.state.jellyfishDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
									{
										label: 'Venstar',
										value: deps.state.venstarDiscoveryDiagnostics
											? 'captured'
											: 'none',
									},
								])}
							</section>
						</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.diagnostics.method,
		typeof routes.diagnostics.pattern
	>
}

function renderNeighborTable(
	neighbors: Awaited<
		ReturnType<ReturnType<typeof createIslandRouterAdapter>['getStatus']>
	>['neighbors'],
) {
	if (neighbors.length === 0) {
		return renderEmptyState(
			'No neighbor entries were returned by the Island router.',
		)
	}

	return renderDataTable({
		headers: ['IP', 'MAC', 'Interface', 'State'],
		rows: neighbors
			.slice(0, 25)
			.map((neighbor) => [
				neighbor.ipAddress ?? 'unknown',
				neighbor.macAddress ?? 'unknown',
				neighbor.interfaceName ?? 'unknown',
				neighbor.state ?? 'unknown',
			]),
	})
}

function renderInterfaceTable(
	interfaces: Awaited<
		ReturnType<ReturnType<typeof createIslandRouterAdapter>['getStatus']>
	>['interfaces'],
) {
	if (interfaces.length === 0) {
		return renderEmptyState(
			'No interface summaries were returned by the Island router.',
		)
	}

	return renderDataTable({
		headers: ['Interface', 'Link', 'Speed', 'Duplex', 'Description'],
		rows: interfaces.map((entry) => [
			entry.name ?? 'unknown',
			entry.linkState ?? 'unknown',
			entry.speed ?? 'unknown',
			entry.duplex ?? 'unknown',
			entry.description ?? 'none',
		]),
	})
}

function getRequestedHost(request: Request) {
	const url = new URL(request.url)
	return url.searchParams.get('host')?.trim() || ''
}

export function createIslandRouterStatusHandler(deps: DashboardDependencies) {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			const requestedHost = getRequestedHost(request)
			const routerStatus = await deps.islandRouter.getStatus()
			const snapshot = await loadDashboardSnapshot(deps, {
				islandRouterStatus: routerStatus,
			})

			let hostDiagnosis: Awaited<
				ReturnType<ReturnType<typeof createIslandRouterAdapter>['diagnoseHost']>
			> | null = null
			let hostDiagnosisError: string | null = null

			if (requestedHost) {
				try {
					hostDiagnosis = await deps.islandRouter.diagnoseHost({
						host: requestedHost,
					})
				} catch (error) {
					hostDiagnosisError =
						error instanceof Error ? error.message : String(error)
				}
			}

			return render(
				RootLayout({
					title: 'home connector - island router status',
					currentPath: routes.islandRouterStatus.pattern,
					body: html`${renderPageIntro({
							eyebrow: 'Island router',
							title: 'Island router status',
							description:
								'Router-state diagnostics surfaced directly in the local admin UI, including SSH readiness, interface summaries, neighbors, and host-level drill-downs.',
							actions: [
								{ href: routes.home.pattern, label: 'Dashboard' },
								{ href: routes.diagnostics.pattern, label: 'Diagnostics' },
							],
						})}
						<div class="metric-grid">
							${renderMetricCard({
								label: 'Router health',
								value: snapshot.islandRouter.statusLabel,
								detail:
									snapshot.islandRouter.versionModel ??
									'Router version not available yet.',
								tone: snapshot.islandRouter.tone,
							})}
							${renderMetricCard({
								label: 'Verification',
								value: routerStatus.config.verificationMode,
								detail: routerStatus.config.configured
									? 'SSH configuration is complete enough to attempt commands.'
									: 'Set the missing fields below to enable SSH-backed diagnostics.',
								tone: routerStatus.config.configured ? 'good' : 'warn',
							})}
							${renderMetricCard({
								label: 'Interfaces',
								value: routerStatus.interfaces.length,
								detail: routerStatus.router.clock ?? 'Clock unavailable',
								tone: routerStatus.interfaces.length > 0 ? 'good' : 'warn',
							})}
							${renderMetricCard({
								label: 'Neighbors',
								value: routerStatus.neighbors.length,
								detail: `${routerStatus.errors.length} router error(s)`,
								tone: routerStatus.errors.length > 0 ? 'bad' : 'good',
							})}
						</div>
						<section class="card-grid">
							<section class="card">
								<div class="card-heading">
									<h2>SSH configuration</h2>
									${renderStatusBadge({
										label: snapshot.islandRouter.statusLabel,
										tone: snapshot.islandRouter.tone,
									})}
								</div>
								${renderInfoRows([
									{
										label: 'Host',
										value: deps.config.islandRouterHost
											? html`<code>${deps.config.islandRouterHost}</code>`
											: 'missing',
									},
									{
										label: 'Port',
										value: String(deps.config.islandRouterPort),
									},
									{
										label: 'Username',
										value: deps.config.islandRouterUsername ?? 'missing',
									},
									{
										label: 'Private key path',
										value: deps.config.islandRouterPrivateKeyPath
											? html`<code
													>${deps.config.islandRouterPrivateKeyPath}</code
												>`
											: 'missing',
									},
									{
										label: 'Known hosts path',
										value: deps.config.islandRouterKnownHostsPath
											? html`<code
													>${deps.config.islandRouterKnownHostsPath}</code
												>`
											: 'none',
									},
									{
										label: 'Fingerprint',
										value: deps.config.islandRouterHostFingerprint
											? html`<code
													>${deps.config.islandRouterHostFingerprint}</code
												>`
											: 'none',
									},
								])}
								${renderConfigWarningList(routerStatus.config)}
							</section>
							<section class="card">
								<div class="card-heading">
									<h2>Router snapshot</h2>
									<p class="muted">
										Live router metadata returned from SSH commands.
									</p>
								</div>
								${renderInfoRows([
									{
										label: 'Connected',
										value: routerStatus.connected ? 'yes' : 'no',
									},
									{
										label: 'Model',
										value: routerStatus.router.version?.model ?? 'unknown',
									},
									{
										label: 'Serial number',
										value:
											routerStatus.router.version?.serialNumber ?? 'unknown',
									},
									{
										label: 'Firmware',
										value:
											routerStatus.router.version?.firmwareVersion ?? 'unknown',
									},
									{
										label: 'Clock',
										value: routerStatus.router.clock ?? 'unknown',
									},
								])}
								${routerStatus.errors.length > 0
									? html`<ul class="list">
											${routerStatus.errors.map(
												(error) => html`<li>${error}</li>`,
											)}
										</ul>`
									: renderEmptyState(
											'No router-side errors were reported in the current snapshot.',
										)}
							</section>
						</section>
						<section class="card">
							<div class="card-heading">
								<h2>Host diagnosis</h2>
								<p class="muted">
									Pass <code>?host=192.168.1.10</code> or a hostname to run a
									router-side diagnosis from this page.
								</p>
							</div>
							${requestedHost
								? hostDiagnosisError
									? renderEmptyState(
											`Host diagnosis failed: ${hostDiagnosisError}`,
										)
									: hostDiagnosis
										? html`${renderInfoRows([
												{
													label: 'Requested host',
													value: hostDiagnosis.host.value,
												},
												{
													label: 'Parsed kind',
													value: hostDiagnosis.host.kind,
												},
												{
													label: 'Ping',
													value: hostDiagnosis.ping
														? hostDiagnosis.ping.reachable
															? 'reachable'
															: hostDiagnosis.ping.timedOut
																? 'timed out'
																: 'no reply'
														: 'not run',
												},
												{
													label: 'Neighbor match',
													value:
														hostDiagnosis.arpEntry?.ipAddress ??
														hostDiagnosis.arpEntry?.macAddress ??
														'none',
												},
												{
													label: 'DHCP match',
													value:
														hostDiagnosis.dhcpLease?.ipAddress ??
														hostDiagnosis.dhcpLease?.macAddress ??
														'none',
												},
												{
													label: 'Recent events',
													value: String(hostDiagnosis.recentEvents.length),
												},
											])}
											${hostDiagnosis.errors.length > 0
												? html`<ul class="list">
														${hostDiagnosis.errors.map(
															(error) => html`<li>${error}</li>`,
														)}
													</ul>`
												: ''}
											${hostDiagnosis.ping
												? html`<section class="card">
														<h3>Ping raw output</h3>
														${renderCodeBlock(hostDiagnosis.ping.rawOutput)}
													</section>`
												: ''}
											${hostDiagnosis.recentEvents.length > 0
												? html`<section class="card">
														<h3>Recent matching events</h3>
														${renderDataTable({
															headers: [
																'Timestamp',
																'Level',
																'Module',
																'Message',
															],
															rows: hostDiagnosis.recentEvents.map((event) => [
																event.timestamp ?? 'unknown',
																event.level ?? 'unknown',
																event.module ?? 'unknown',
																event.message,
															]),
														})}
													</section>`
												: ''}
											${hostDiagnosis.interfaceDetails
												? html`<section class="card">
														<h3>Interface details</h3>
														${renderCodeBlock(
															hostDiagnosis.interfaceDetails.rawOutput,
														)}
													</section>`
												: ''}`
										: renderEmptyState(
												'No host diagnosis data was produced for the requested host.',
											)
								: renderEmptyState(
										'Append a host query parameter to run a router-side diagnosis from this page.',
									)}
						</section>
						<section class="card-grid">
							<section class="card">
								<div class="card-heading">
									<h2>Interface summary</h2>
									<p class="muted">
										First-class interface data from the router.
									</p>
								</div>
								${renderInterfaceTable(routerStatus.interfaces)}
							</section>
							<section class="card">
								<div class="card-heading">
									<h2>Neighbor cache</h2>
									<p class="muted">Current parsed IP neighbor table.</p>
								</div>
								${renderNeighborTable(routerStatus.neighbors)}
							</section>
						</section>
						<section class="card">
							<div class="card-heading">
								<h2>Raw status payload</h2>
								<p class="muted">
									Useful when comparing the UI output with MCP router tools.
								</p>
							</div>
							${renderCodeBlock(formatJson(routerStatus))}
						</section>`,
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.islandRouterStatus.method,
		typeof routes.islandRouterStatus.pattern
	>
}
