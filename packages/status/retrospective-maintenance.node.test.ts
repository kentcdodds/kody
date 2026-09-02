import { expect, test } from 'vitest'
import {
	handleIncidentRetrospectiveRequest,
	incidentRetrospectiveNotConfiguredMessage,
	parseIncidentRetrospectivePath,
	unknownStatusMaintenanceResponse,
} from './retrospective-maintenance.ts'
import {
	stampIncidentRetrospective,
	type IncidentRetrospective,
} from './retrospective.ts'
import { type IncidentView } from './status-types.ts'

function retrospectiveRequest(input: {
	method?: string
	authorization?: string | null
	body?: unknown
}) {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (input.authorization !== null) {
		headers.set('authorization', input.authorization ?? 'Bearer shared-secret')
	}
	return new Request(
		'https://status.kody.codes/__maintenance/incidents/10/retrospective',
		{
			method: input.method ?? 'POST',
			headers,
			body:
				input.method === 'GET'
					? undefined
					: JSON.stringify(
							input.body ?? {
								whatHappened: 'Probes failed twice.',
								impact: 'Jobs card went red.',
								timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Opened.' }],
								cause: 'Unconfirmed.',
								whatWeDid: 'Probes recovered.',
								whatWeWillChange: 'Publish retrospectives.',
							},
						),
		},
	)
}

function incidentView(
	retrospective: IncidentRetrospective | null = null,
): IncidentView {
	return {
		id: 10,
		component: 'jobs',
		componentName: 'Jobs',
		startedAt: '2026-09-02T21:57:54.765Z',
		resolvedAt: '2026-09-02T22:00:51.866Z',
		detail: 'error',
		retrospective,
	}
}

test('retrospective maintenance path authenticates and writes only resolved incidents', async () => {
	expect(
		parseIncidentRetrospectivePath('/__maintenance/incidents/10/retrospective'),
	).toBe(10)
	expect(
		parseIncidentRetrospectivePath('/__maintenance/incidents/0/retrospective'),
	).toBe(null)
	expect(
		parseIncidentRetrospectivePath('/__maintenance/status-incidents'),
	).toBe(null)
	expect(unknownStatusMaintenanceResponse().status).toBe(404)

	const getResponse = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({ method: 'GET' }),
		incidentId: 10,
		secret: 'shared-secret',
		setRetrospective: async () => {
			throw new Error('should not write')
		},
	})
	expect(getResponse.status).toBe(405)

	const unset = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({}),
		incidentId: 10,
		secret: '  ',
		setRetrospective: async () => {
			throw new Error('should not write')
		},
	})
	expect(unset.status).toBe(503)
	expect(await unset.text()).toBe(incidentRetrospectiveNotConfiguredMessage)

	const unauthorized = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({ authorization: 'Bearer wrong' }),
		incidentId: 10,
		secret: 'shared-secret',
		setRetrospective: async () => {
			throw new Error('should not write')
		},
	})
	expect(unauthorized.status).toBe(401)

	const missingBearer = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({ authorization: null }),
		incidentId: 10,
		secret: 'shared-secret',
		setRetrospective: async () => {
			throw new Error('should not write')
		},
	})
	expect(missingBearer.status).toBe(401)

	const invalidBody = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({ body: { whatHappened: 'only' } }),
		incidentId: 10,
		secret: 'shared-secret',
		setRetrospective: async () => {
			throw new Error('should not write')
		},
	})
	expect(invalidBody.status).toBe(400)
	expect(await invalidBody.json()).toMatchObject({ ok: false })

	const publishedAt = Date.parse('2026-09-02T22:20:00.000Z')
	let written: IncidentRetrospective | null = null
	const ok = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({}),
		incidentId: 10,
		secret: 'shared-secret',
		now: publishedAt,
		setRetrospective: async (id, retrospective) => {
			expect(id).toBe(10)
			written = retrospective
			return { ok: true, incident: incidentView(retrospective) }
		},
	})
	expect(ok.status).toBe(200)
	const okBody = (await ok.json()) as {
		ok: boolean
		incident: IncidentView
	}
	expect(okBody.ok).toBe(true)
	expect(okBody.incident.retrospective?.publishedAt).toBe(
		'2026-09-02T22:20:00.000Z',
	)
	expect(written).toEqual(
		stampIncidentRetrospective(
			{
				whatHappened: 'Probes failed twice.',
				impact: 'Jobs card went red.',
				timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Opened.' }],
				cause: 'Unconfirmed.',
				whatWeDid: 'Probes recovered.',
				whatWeWillChange: 'Publish retrospectives.',
			},
			publishedAt,
		),
	)

	const notFound = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({}),
		incidentId: 99,
		secret: 'shared-secret',
		setRetrospective: async () => ({ ok: false, error: 'not-found' }),
	})
	expect(notFound.status).toBe(404)

	const openIncident = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({}),
		incidentId: 11,
		secret: 'shared-secret',
		setRetrospective: async () => ({ ok: false, error: 'not-resolved' }),
	})
	expect(openIncident.status).toBe(409)
})
