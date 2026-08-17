import { timingSafeEqualString } from '#worker/maintenance-handler.ts'
import { dispatchStatusIncidentSubscriptionEvent } from './package-subscriptions.ts'
import { parseStatusIncidentEvent } from './parse-event.ts'

export const statusIncidentEventPath = '/__maintenance/status-incidents'
export const statusIncidentEventsNotConfiguredMessage =
	'Status incident events are not configured'

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

/**
 * Secret-gated ingress for the isolated status worker. Accepts the incident
 * payload, fans out to admin package subscriptions in the background, and
 * returns quickly so a slow subscriber cannot stall probe recording.
 */
export async function handleStatusIncidentEventRequest(
	request: Request,
	env: Env,
	ctx: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const secret = env.STATUS_INCIDENT_EVENT_SECRET?.trim()
	if (!secret) {
		return new Response(statusIncidentEventsNotConfiguredMessage, {
			status: 503,
		})
	}

	const bearer = readBearerToken(request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
		return new Response('Unauthorized', { status: 401 })
	}

	const body = await request.json().catch(() => null)
	const parsed = parseStatusIncidentEvent(body)
	if (!parsed.ok) {
		return Response.json({ ok: false, error: parsed.error }, { status: 400 })
	}

	ctx.waitUntil(
		dispatchStatusIncidentSubscriptionEvent({
			env,
			event: parsed.event,
			waitUntil: ctx.waitUntil,
		}).catch((error) => {
			console.warn('status-incident-subscription-dispatch-failed', {
				event: parsed.event.event,
				component: parsed.event.incident.component,
				error,
			})
		}),
	)

	return Response.json({
		ok: true,
		accepted: true,
		event: parsed.event.event,
	})
}
