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

test('status page renders components, incidents, unknown state, and escapes detail html', () => {
	const healthy = renderStatusPage(snapshot())
	for (const component of statusComponents) {
		expect(healthy).toContain(component.name.replaceAll('&', '&amp;'))
	}
	expect(healthy).toContain('99.98% uptime')
	expect(healthy).toContain('http-equiv="refresh"')
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
})
