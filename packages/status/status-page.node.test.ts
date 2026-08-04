import { expect, test } from 'vitest'
import { renderStatusPage } from './status-page.ts'
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
			{ day: '2026-08-03', total: 1440, failed: 0 },
			{ day: '2026-08-04', total: 720, failed: 3 },
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
		buildCommit: 'abc123',
		...overrides,
	}
}

test('healthy snapshot renders the all-operational banner and every component', () => {
	const html = renderStatusPage(snapshot())
	expect(html).toContain('All systems operational')
	for (const component of statusComponents) {
		expect(html).toContain(component.name.replaceAll('&', '&amp;'))
	}
	expect(html).toContain('99.98% uptime')
	expect(html).toContain('http-equiv="refresh"')
})

test('a down component renders the problem banner and the open incident', () => {
	const html = renderStatusPage(
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
	expect(html).toContain('Some systems are experiencing problems')
	expect(html).toContain('Primary database is down')
	expect(html).toContain('since 2026-08-04T11:00:00.000Z')
})

test('incident details are html-escaped', () => {
	const html = renderStatusPage(
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
	expect(html).not.toContain('<img src=x')
	expect(html).toContain('&lt;img src=x')
})

test('a snapshot with no data renders the unknown banner', () => {
	const html = renderStatusPage(
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
	expect(html).toContain('Status data is not available yet')
	expect(html).toContain('no data yet')
})
