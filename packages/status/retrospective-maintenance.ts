/**
 * Secret-gated write for attaching a retrospective to a resolved incident.
 * Lives on the status worker so origin / APP_DB being down cannot block it.
 */

import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import {
	parseIncidentRetrospectiveInput,
	stampIncidentRetrospective,
	type IncidentRetrospective,
} from './retrospective.ts'
import { type IncidentView } from './status-types.ts'

const incidentRetrospectivePathPrefix = '/__maintenance/incidents/'
const incidentRetrospectivePathSuffix = '/retrospective'
const incidentRetrospectiveNotConfiguredMessage =
	'Status incident retrospectives are not configured'

export type SetIncidentRetrospectiveResult =
	| { ok: true; incident: IncidentView }
	| { ok: false; error: 'not-found' | 'not-resolved' }

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

export function parseIncidentRetrospectivePath(
	pathname: string,
): number | null {
	if (
		!pathname.startsWith(incidentRetrospectivePathPrefix) ||
		!pathname.endsWith(incidentRetrospectivePathSuffix)
	) {
		return null
	}
	const idPart = pathname.slice(
		incidentRetrospectivePathPrefix.length,
		pathname.length - incidentRetrospectivePathSuffix.length,
	)
	if (!/^\d+$/.test(idPart)) return null
	const id = Number(idPart)
	if (!Number.isInteger(id) || id < 1) return null
	return id
}

export async function handleIncidentRetrospectiveRequest(input: {
	request: Request
	incidentId: number
	secret: string | null | undefined
	now?: number
	setRetrospective: (
		id: number,
		retrospective: IncidentRetrospective,
	) => Promise<SetIncidentRetrospectiveResult>
}): Promise<Response> {
	if (input.request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const secret = input.secret?.trim()
	if (!secret) {
		return new Response(incidentRetrospectiveNotConfiguredMessage, {
			status: 503,
		})
	}

	const bearer = readBearerToken(input.request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
		return new Response('Unauthorized', { status: 401 })
	}

	const body = await input.request.json().catch(() => null)
	const parsed = parseIncidentRetrospectiveInput(body)
	if (!parsed.ok) {
		return Response.json(
			{ ok: false, error: parsed.message },
			{ status: 400, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const retrospective = stampIncidentRetrospective(
		parsed.retrospective,
		input.now ?? Date.now(),
	)
	const result = await input.setRetrospective(input.incidentId, retrospective)
	if (!result.ok) {
		const status = result.error === 'not-found' ? 404 : 409
		const error =
			result.error === 'not-found'
				? 'incident not found'
				: 'retrospective requires a resolved incident'
		return Response.json(
			{ ok: false, error },
			{ status, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	return Response.json(
		{ ok: true, incident: result.incident },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

export function unknownStatusMaintenanceResponse(): Response {
	return Response.json(
		{ error: 'Unknown maintenance endpoint.' },
		{ status: 404, headers: { 'Cache-Control': 'no-store' } },
	)
}
