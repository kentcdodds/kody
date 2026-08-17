/**
 * Optional outbound notify when the status worker opens or resolves an
 * incident.
 *
 * The status worker stays dependency-free (ADR 0004): this is a plain HTTPS
 * POST to the main worker's secret-gated maintenance route. Probe recording
 * must not fail if the secret is unset, the origin is down, or fan-out is
 * slow. Sweep polling of /status.json remains the backstop.
 */

export const statusIncidentEventTimeoutMs = 3000
export const statusIncidentEventPath = '/__maintenance/status-incidents'

export type StatusIncidentOpenedPayload = {
	event: 'status.incident.opened'
	status_url: string
	incident: {
		component: string
		detail: string | null
		started_at: string
	}
}

export type StatusIncidentResolvedPayload = {
	event: 'status.incident.resolved'
	status_url: string
	incident: {
		component: string
		detail: string | null
		started_at: string
		resolved_at: string
	}
}

export type StatusIncidentEventPayload =
	| StatusIncidentOpenedPayload
	| StatusIncidentResolvedPayload

export type StatusIncidentEventResult =
	| { ok: true; skipped: 'unset' }
	| { ok: true; status: number }
	| { ok: false; error: string }

export function buildStatusIncidentOpenedPayload(input: {
	component: string
	detail: string | null
	startedAt: number
	statusUrl: string
}): StatusIncidentOpenedPayload {
	return {
		event: 'status.incident.opened',
		status_url: input.statusUrl,
		incident: {
			component: input.component,
			detail: input.detail,
			started_at: new Date(input.startedAt).toISOString(),
		},
	}
}

export function buildStatusIncidentResolvedPayload(input: {
	component: string
	detail: string | null
	startedAt: number
	resolvedAt: number
	statusUrl: string
}): StatusIncidentResolvedPayload {
	return {
		event: 'status.incident.resolved',
		status_url: input.statusUrl,
		incident: {
			component: input.component,
			detail: input.detail,
			started_at: new Date(input.startedAt).toISOString(),
			resolved_at: new Date(input.resolvedAt).toISOString(),
		},
	}
}

export async function notifyStatusIncidentEvent(input: {
	primaryOrigin: string | null | undefined
	secret: string | null | undefined
	payload: StatusIncidentEventPayload
	fetchImpl?: typeof fetch
}): Promise<StatusIncidentEventResult> {
	const secret = input.secret?.trim()
	const primaryOrigin = input.primaryOrigin?.trim()
	if (!secret || !primaryOrigin) return { ok: true, skipped: 'unset' }

	let url: URL
	try {
		url = new URL(statusIncidentEventPath, primaryOrigin)
	} catch {
		return { ok: false, error: 'invalid-origin' }
	}
	if (url.protocol !== 'https:') return { ok: false, error: 'insecure-origin' }

	try {
		const response = await (input.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(input.payload),
			signal: AbortSignal.timeout(statusIncidentEventTimeoutMs),
		})
		if (!response.ok) {
			return { ok: false, error: `http-${response.status}` }
		}
		return { ok: true, status: response.status }
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
