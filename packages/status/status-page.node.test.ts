import { expect, test } from 'vitest'
import { faviconIcoRedirectLocation, statusFaviconPath } from './favicon.ts'
import { renderStatusPage, renderStatusUnavailablePage } from './status-page.ts'
import {
	statusComponents,
	type ComponentSnapshot,
	type StatusSnapshot,
} from './status-types.ts'

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
		...overrides,
	}
}

test('status page renders components, incidents, unknown state, and escapes detail html', () => {
	const healthy = renderStatusPage(snapshot())
	for (const component of statusComponents) {
		expect(healthy).toContain(component.name.replaceAll('&', '&amp;'))
	}
	expect(healthy).toContain('99.98% uptime (4 days)')
	expect(healthy).toContain('class="bar"')
	expect(healthy).toContain('class="bar partial"')
	expect(healthy).toContain('class="bar bad"')
	expect(healthy).toContain(
		'https://github.com/kentcdodds/kody/commit/abc123def4567890abcdef1234567890abcdef12',
	)
	expect(healthy).toContain(
		'https://github.com/kentcdodds/kody/commit/def4567890abcdef1234567890abcdef12345678',
	)
	expect(healthy).toContain(
		'https://github.com/kentcdodds/kody/commit/7890abcdef1234567890abcdef1234567890abcd',
	)
	expect(healthy).toContain('>abc123d<')
	expect(healthy).toContain('>def4567<')
	expect(healthy).toContain('>7890abc<')
	expect(healthy).toContain('http-equiv="refresh"')
	expect(healthy).toContain(`href="${statusFaviconPath('operational')}"`)
	expect(healthy).toMatch(/operational|All systems/i)

	const down = renderStatusPage(
		snapshot({
			overallStatus: 'down',
			openIncidents: [
				{
					id: 1,
					component: 'app_db',
					componentName: 'Primary database',
					startedAt: '2026-08-04T11:00:00.000Z',
					resolvedAt: null,
					detail: 'timeout',
				},
			],
		}),
	)
	expect(down).toContain('Primary database')
	expect(down).toContain('2026-08-04T11:00:00.000Z')
	expect(down).toContain(`href="${statusFaviconPath('down')}"`)
	expect(down).not.toContain(`href="${statusFaviconPath('operational')}"`)

	const escaped = renderStatusPage(
		snapshot({
			recentIncidents: [
				{
					id: 2,
					component: 'kv',
					componentName: 'Key-value storage',
					startedAt: '2026-08-01T00:00:00.000Z',
					resolvedAt: '2026-08-01T01:00:00.000Z',
					detail: '<img src=x onerror=alert(1)>',
				},
			],
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

	const unavailable = renderStatusUnavailablePage(
		'Status data is temporarily unavailable.',
	)
	expect(unavailable).toContain('Status data is temporarily unavailable.')
	expect(unavailable).toContain(`href="${statusFaviconPath('unknown')}"`)
	expect(unavailable).toContain('http-equiv="refresh"')

	expect(
		faviconIcoRedirectLocation('https://status.kody.codes/favicon.ico', 'down'),
	).toBe(`https://status.kody.codes${statusFaviconPath('down')}`)
})

test('status page renders provider incidents separately and omits them when absent', () => {
	const without = renderStatusPage(snapshot({ providerIncidents: null }))
	expect(without).not.toContain('Provider incidents (Cloudflare)')

	const empty = renderStatusPage(snapshot({ providerIncidents: [] }))
	expect(empty).not.toContain('Provider incidents (Cloudflare)')

	const withProvider = renderStatusPage(
		snapshot({
			overallStatus: 'operational',
			providerIncidents: [
				{
					id: 'inc-r2',
					name: 'R2 Availability Issues',
					status: 'investigating',
					impact: 'minor',
					shortlink: 'https://stspg.io/r2',
					updatedAt: '2026-08-07T19:00:00.000Z',
					affectedComponents: ['R2'],
				},
			],
		}),
	)
	expect(withProvider).toContain('Provider incidents (Cloudflare)')
	expect(withProvider).toContain('R2 Availability Issues')
	expect(withProvider).toContain('https://stspg.io/r2')

	const withoutCommit = renderStatusPage(
		snapshot({
			productionCommit: null,
			runtimeCommit: null,
			jobsCommit: null,
		}),
	)
	expect(withoutCommit).not.toContain(
		'https://github.com/kentcdodds/kody/commit/',
	)

	const unsafeLink = renderStatusPage(
		snapshot({
			providerIncidents: [
				{
					id: 'inc-r2',
					name: 'R2 Availability Issues',
					status: 'investigating',
					impact: 'minor',
					shortlink: 'javascript:alert(1)',
					updatedAt: '2026-08-07T19:00:00.000Z',
					affectedComponents: ['R2'],
				},
			],
		}),
	)
	expect(unsafeLink).not.toContain('javascript:alert')
	expect(unsafeLink).toContain('https://www.cloudflarestatus.com')
})
