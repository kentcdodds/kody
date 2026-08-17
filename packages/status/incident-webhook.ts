/**
 * Optional outbound notify when the status worker opens an incident.
 *
 * The status worker stays dependency-free (ADR 0004): this is a plain HTTPS
 * POST to a minted Kody webhook URL. Probe recording must not fail if the
 * webhook is unset, slow, or down.
 */

export const statusIncidentWebhookTimeoutMs = 3000

export type StatusIncidentOpenedPayload = {
	event: 'incident.opened'
	component: string
	detail: string | null
	startedAt: number
	statusUrl: string
}

export type StatusIncidentWebhookResult =
	| { ok: true; skipped: 'unset' }
	| { ok: true; status: number }
	| { ok: false; error: string }

export async function notifyStatusIncidentOpened(input: {
	webhookUrl: string | null | undefined
	payload: StatusIncidentOpenedPayload
	fetchImpl?: typeof fetch
}): Promise<StatusIncidentWebhookResult> {
	const webhookUrl = input.webhookUrl?.trim()
	if (!webhookUrl) return { ok: true, skipped: 'unset' }

	let url: URL
	try {
		url = new URL(webhookUrl)
	} catch {
		return { ok: false, error: 'invalid-url' }
	}
	if (url.protocol !== 'https:') return { ok: false, error: 'insecure-url' }

	try {
		const response = await (input.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input.payload),
			signal: AbortSignal.timeout(statusIncidentWebhookTimeoutMs),
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
