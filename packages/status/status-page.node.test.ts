import { expect, test } from 'vitest'
import { faviconIcoRedirectLocation, statusFaviconPath } from './favicon.ts'
import {
	renderMaintenancePage,
	renderStatusPage,
	renderStatusUnavailablePage,
} from './status-page.ts'
import {
	statusComponents,
	type ComponentSnapshot,
	type StatusSnapshot,
} from './status-types.ts'

type Incident = StatusSnapshot['recentIncidents'][number]
type ProviderIncident = NonNullable<StatusSnapshot['providerIncidents']>[number]

function componentSnapshot(
	overrides: Partial<ComponentSnapshot> = {},
): ComponentSnapshot {
	return {
		id: 'app',
		name: 'App & API',
		status: 'operational',
		latencyMs: 42,
		uptimePct: 99.98,
		days: [
			{ day: '2026-08-03', total: 1440, failed: 0, incidentMinutes: 0 },
			{ day: '2026-08-04', total: 720, failed: 3, incidentMinutes: 0 },
			{ day: '2026-08-05', total: 1440, failed: 6, incidentMinutes: 6 },
			{ day: '2026-08-06', total: 1440, failed: 90, incidentMinutes: 90 },
		],
		...overrides,
	}
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		generatedAt: '2026-08-04T12:00:00.000Z',
		overallStatus: 'operational',
		components: statusComponents.map((component) =>
			componentSnapshot({ id: component.id, name: component.name }),
		),
		openIncidents: [],
		recentIncidents: [],
		providerIncidents: null,
		productionCommit: 'abc123def4567890abcdef1234567890abcdef12',
		runtimeCommit: 'def4567890abcdef1234567890abcdef12345678',
		jobsCommit: '7890abcdef1234567890abcdef1234567890abcd',
		executeHealth: {
			status: 'recent',
			source: 'organic',
			lastVerifiedAt: '2026-08-04T11:59:50.000Z',
			freshnessMs: 10_000,
			detail: 'Verified by organic MCP execute traffic 10s ago.',
		},
		...overrides,
	}
}

const incident = (overrides: Partial<Incident> = {}): Incident => ({
	id: 10,
	component: 'jobs',
	componentName: 'Jobs',
	startedAt: '2026-09-02T21:57:54.765Z',
	resolvedAt: '2026-09-02T22:00:51.866Z',
	detail: 'error',
	retrospective: null,
	...overrides,
})

const providerIncident = (shortlink: string): ProviderIncident => ({
	id: 'inc-r2',
	name: 'R2 Availability Issues',
	status: 'investigating',
	impact: 'minor',
	shortlink,
	updatedAt: '2026-08-07T19:00:00.000Z',
	affectedComponents: ['R2'],
})

const missing = (html: string, fragments: Array<string>) =>
	fragments.filter((fragment) => !html.includes(fragment))
const commitUrl = 'https://github.com/kentcdodds/kody/commit/'

test('status page renders components, incidents, unknown state, and escapes detail html', () => {
	const healthy = renderStatusPage(snapshot())
	expect(
		missing(healthy, [
			...statusComponents.map((component) =>
				component.name.replaceAll('&', '&amp;'),
			),
			'99.98% uptime (4 days)',
			'class="bar"',
			'class="bar partial"',
			'class="bar bad"',
			`${commitUrl}abc123def4567890abcdef1234567890abcdef12`,
			`${commitUrl}def4567890abcdef1234567890abcdef12345678`,
			`${commitUrl}7890abcdef1234567890abcdef1234567890abcd`,
			'>abc123d<',
			'>def4567<',
			'>7890abc<',
			'http-equiv="refresh"',
			'<title>Kody status</title>',
			`href="${statusFaviconPath('operational')}"`,
			'MCP execute',
			'Recently verified',
			'organic traffic',
			'2026-08-04T11:59:50.000Z',
			'Verified by organic MCP execute traffic 10s ago.',
		]),
	).toEqual([])
	expect(healthy).toMatch(/operational|All systems/i)

	const down = renderStatusPage(
		snapshot({
			overallStatus: 'down',
			openIncidents: [
				incident({
					id: 1,
					component: 'app_db',
					componentName: 'Primary database',
					startedAt: '2026-08-04T11:00:00.000Z',
					resolvedAt: null,
					detail: 'timeout',
				}),
			],
		}),
	)
	expect(
		missing(down, [
			'Primary database',
			'2026-08-04T11:00:00.000Z',
			`href="${statusFaviconPath('down')}"`,
		]),
	).toEqual([])
	expect(down).not.toContain(`href="${statusFaviconPath('operational')}"`)

	const escaped = renderStatusPage(
		snapshot({
			recentIncidents: [incident({ detail: '<img src=x onerror=alert(1)>' })],
		}),
	)
	expect(escaped).not.toContain('<img src=x')
	expect(escaped).toContain('&lt;img src=x')

	const unknown = renderStatusPage(
		snapshot({
			overallStatus: 'unknown',
			components: statusComponents.map((component) =>
				componentSnapshot({
					id: component.id,
					name: component.name,
					status: 'unknown',
					latencyMs: null,
					uptimePct: null,
					days: [],
				}),
			),
		}),
	)
	expect(unknown).toMatch(/not available|no data/i)
	expect(unknown).toContain(`href="${statusFaviconPath('unknown')}"`)

	const executeUnknown = renderStatusPage(
		snapshot({
			executeHealth: {
				status: 'unknown',
				source: null,
				lastVerifiedAt: null,
				freshnessMs: null,
				detail:
					'Not recently exercised. Missing or stale telemetry is not an outage and is not proof the path is freshly healthy.',
			},
		}),
	)
	expect(
		missing(executeUnknown, [
			'Not recently exercised',
			'Last verified time is unknown',
			'Missing or stale telemetry is not an outage',
		]),
	).toEqual([])

	const unavailable = renderStatusUnavailablePage(
		'Status data is temporarily unavailable.',
	)
	expect(
		missing(unavailable, [
			'Status data is temporarily unavailable.',
			'<title>Kody status</title>',
			`href="${statusFaviconPath('unknown')}"`,
			'http-equiv="refresh"',
		]),
	).toEqual([])

	expect(
		faviconIcoRedirectLocation('https://status.kody.codes/favicon.ico', 'down'),
	).toBe(`https://status.kody.codes${statusFaviconPath('down')}`)

	const maintenance = renderMaintenancePage()
	expect(
		missing(maintenance, [
			'href="https://status.kody.codes/"',
			`href="${statusFaviconPath('unknown')}"`,
		]),
	).toEqual([])
})

test('status page renders provider incidents separately, omits them when absent, and hides missing commits', () => {
	for (const providerIncidents of [null, []]) {
		expect(renderStatusPage(snapshot({ providerIncidents }))).not.toContain(
			'Provider incidents (Cloudflare)',
		)
	}

	const withProvider = renderStatusPage(
		snapshot({ providerIncidents: [providerIncident('https://stspg.io/r2')] }),
	)
	expect(
		missing(withProvider, [
			'Provider incidents (Cloudflare)',
			'R2 Availability Issues',
			'https://stspg.io/r2',
		]),
	).toEqual([])

	const unsafeLink = renderStatusPage(
		snapshot({ providerIncidents: [providerIncident('javascript:alert(1)')] }),
	)
	expect(unsafeLink).not.toContain('javascript:alert')
	expect(unsafeLink).toContain('https://www.cloudflarestatus.com')

	expect(
		renderStatusPage(
			snapshot({
				productionCommit: null,
				runtimeCommit: null,
				jobsCommit: null,
			}),
		),
	).not.toContain(commitUrl)
})

test('status page keeps resolved incidents glanceable and expands a retrospective', () => {
	const withoutWriteup = renderStatusPage(
		snapshot({ recentIncidents: [incident()] }),
	)
	expect(withoutWriteup).toContain('Jobs outage (resolved) — error')
	expect(withoutWriteup).not.toContain('<details class="retrospective">')

	const withWriteup = renderStatusPage(
		snapshot({
			recentIncidents: [
				incident({
					retrospective: {
						whatHappened: 'Two failed Jobs probes.',
						impact: 'Status page looked alarming.',
						timeline: [
							{
								at: '2026-09-02T21:57:54.765Z',
								note: 'Opened after consecutive failures.',
							},
						],
						cause: 'Unconfirmed. <script>alert(1)</script>',
						whatWeDid: 'Probes recovered.',
						whatWeWillChange: 'Publish retrospectives.',
						publishedAt: '2026-09-02T22:20:00.000Z',
					},
				}),
			],
		}),
	)
	expect(
		missing(withWriteup, [
			'Jobs outage (resolved) — error',
			'<details class="retrospective">',
			'Two failed Jobs probes.',
			'&lt;script&gt;alert(1)&lt;/script&gt;',
		]),
	).toEqual([])
	expect(withWriteup).not.toContain('<script>alert(1)</script>')
})
