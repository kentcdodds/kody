import { expect, test } from 'vitest'
import {
	handleIncidentRetrospectiveRequest,
	parseIncidentRetrospectivePath,
	unknownStatusMaintenanceResponse,
} from './retrospective-maintenance.ts'
import { type IncidentRetrospective } from './retrospective.ts'
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
		[
			'/__maintenance/incidents/10/retrospective',
			'/__maintenance/incidents/0/retrospective',
			'/__maintenance/status-incidents',
		].map(parseIncidentRetrospectivePath),
	).toEqual([10, null, null])
	expect(unknownStatusMaintenanceResponse().status).toBe(404)

	const rejected: Array<[Request, string, number]> = [
		[retrospectiveRequest({ method: 'GET' }), 'shared-secret', 405],
		[retrospectiveRequest({}), '  ', 503],
		[
			retrospectiveRequest({ authorization: 'Bearer wrong' }),
			'shared-secret',
			401,
		],
		[retrospectiveRequest({ authorization: null }), 'shared-secret', 401],
		[
			retrospectiveRequest({ body: { whatHappened: 'only' } }),
			'shared-secret',
			400,
		],
	]
	const responses = await Promise.all(
		rejected.map(([request, secret]) =>
			handleIncidentRetrospectiveRequest({
				request,
				incidentId: 10,
				secret,
				setRetrospective: async () => {
					throw new Error('should not write')
				},
			}),
		),
	)
	expect(responses.map((response) => response.status)).toEqual(
		rejected.map(([, , status]) => status),
	)
	expect(await responses.at(-1)!.json()).toMatchObject({ ok: false })

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
	const okBody = (await ok.json()) as { ok: boolean; incident: IncidentView }
	expect(okBody.ok).toBe(true)
	expect(okBody.incident.retrospective?.publishedAt).toBe(
		'2026-09-02T22:20:00.000Z',
	)
	expect(written).toEqual({
		whatHappened: 'Probes failed twice.',
		impact: 'Jobs card went red.',
		timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Opened.' }],
		cause: 'Unconfirmed.',
		whatWeDid: 'Probes recovered.',
		whatWeWillChange: 'Publish retrospectives.',
		publishedAt: '2026-09-02T22:20:00.000Z',
	})

	for (const [incidentId, error, status] of [
		[99, 'not-found', 404],
		[11, 'not-resolved', 409],
	] as const) {
		const response = await handleIncidentRetrospectiveRequest({
			request: retrospectiveRequest({}),
			incidentId,
			secret: 'shared-secret',
			setRetrospective: async () => ({ ok: false, error }),
		})
		expect(response.status).toBe(status)
	}
})
