import { expect, test } from 'vitest'
import { parseStatusIncidentEvent } from './parse-event.ts'
import {
	buildStatusIncidentOpenedEvent,
	buildStatusIncidentResolvedEvent,
} from './subscription-event.ts'

const opened = buildStatusIncidentOpenedEvent({
	component: 'app_db',
	detail: 'timeout',
	startedAt: '2026-08-17T01:11:00.000Z',
	statusUrl: 'https://status.kody.codes',
})

test('parses opened and resolved status incident events and rejects unsafe fields', () => {
	expect(parseStatusIncidentEvent(opened)).toEqual({ ok: true, event: opened })

	const resolved = buildStatusIncidentResolvedEvent({
		component: 'app_db',
		detail: null,
		startedAt: '2026-08-17T01:11:00.000Z',
		resolvedAt: '2026-08-17T01:13:00.000Z',
		statusUrl: 'https://status.kody.codes',
	})
	expect(parseStatusIncidentEvent(resolved)).toEqual({
		ok: true,
		event: resolved,
	})

	expect(
		parseStatusIncidentEvent({ ...opened, event: 'incident.opened' }),
	).toEqual({
		ok: false,
		error: 'invalid-event',
	})
	expect(
		parseStatusIncidentEvent({
			...opened,
			incident: { ...opened.incident, component: 'AUDIT-DB' },
		}),
	).toEqual({ ok: false, error: 'invalid-component' })
	expect(
		parseStatusIncidentEvent({
			...opened,
			status_url: 'http://status.kody.codes',
		}),
	).toEqual({ ok: false, error: 'invalid-status-url' })
	expect(
		parseStatusIncidentEvent({
			...opened,
			incident: {
				...opened.incident,
				resolved_at: resolved.incident.resolved_at,
			},
		}),
	).toEqual({ ok: false, error: 'unexpected-resolved-at' })
	expect(
		parseStatusIncidentEvent({
			...resolved,
			incident: { ...resolved.incident, resolved_at: 'soon' },
		}),
	).toEqual({ ok: false, error: 'invalid-resolved-at' })
})
