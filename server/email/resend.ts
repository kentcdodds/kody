import { parseSafe } from 'remix/data-schema'
import { resendEmailSchema, type ResendEmail } from '#shared/resend-email.ts'

type ResendClientConfig = {
	apiBaseUrl: string
	apiKey?: string
}

type ResendSendResult = {
	ok: boolean
	id?: string
	skipped?: boolean
	error?: string
}

function normalizeEmailPayload(message: ResendEmail) {
	const result = parseSafe(resendEmailSchema, message)
	if (!result.success) {
		const issueMessage = result.issues
			.map((issue) => {
				const path =
					Array.isArray(issue.path) && issue.path.length > 0
						? issue.path.join('.')
						: 'payload'
				return `${path}: ${issue.message}`
			})
			.join(', ')
		throw new Error(`Invalid Resend email payload: ${issueMessage}`)
	}
	return result.value
}

function logSkippedEmail(reason: string, message: ResendEmail) {
	console.warn(
		reason,
		JSON.stringify({
			to: message.to,
			from: message.from,
			subject: message.subject,
			body: message.html,
		}),
	)
}

export async function sendResendEmail(
	config: ResendClientConfig,
	message: ResendEmail,
): Promise<ResendSendResult> {
	const normalized = normalizeEmailPayload(message)
	if (!config.apiKey) {
		logSkippedEmail('resend-api-key-missing', normalized)
		return { ok: false, skipped: true }
	}

	const baseUrl = config.apiBaseUrl.endsWith('/')
		? config.apiBaseUrl
		: `${config.apiBaseUrl}/`
	const endpoint = new URL('emails', baseUrl)
	const response = await fetch(endpoint.toString(), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(normalized),
	})
	const payload = (await response.json().catch(() => null)) as {
		id?: string
	} | null
	if (!response.ok) {
		console.warn(
			'resend-email-failed',
			JSON.stringify({
				status: response.status,
				body: payload,
				to: normalized.to,
				from: normalized.from,
				subject: normalized.subject,
			}),
		)
		return { ok: false, error: 'Resend API returned an error response.' }
	}

	return {
		ok: true,
		id: typeof payload?.id === 'string' ? payload.id : undefined,
	}
}

export { resendEmailSchema }
