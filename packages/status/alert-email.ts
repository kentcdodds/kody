import { toCloudflareSendBody } from '@kody-internal/shared/cloudflare-send-body.ts'
import { resolveTransactionalSenderReplyTo } from '@kody-internal/shared/transactional-sender-reply-to.ts'

/**
 * Sends operator alert email through the Cloudflare Email REST API — the same
 * mechanism the main worker uses for ops alerts. When credentials are absent
 * (local dev), the send is skipped but reported so the caller can keep its
 * notification state machine consistent.
 */

const defaultApiBaseUrl = 'https://api.cloudflare.com'

export type AlertEmailConfig = {
	accountId?: string
	apiToken?: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}

export type AlertEmailMessage = {
	from: string
	to: string
	subject: string
	text: string
	html: string
	replyTo?: string | null
}

export type AlertEmailResult = {
	delivered: boolean
	skipped?: boolean
	error?: string
}

export async function sendAlertEmail(
	config: AlertEmailConfig,
	message: AlertEmailMessage,
): Promise<AlertEmailResult> {
	const accountId = config.accountId?.trim()
	const apiToken = config.apiToken?.trim()
	if (!accountId || !apiToken) {
		console.info(
			'status-alert-email-unconfigured',
			JSON.stringify({ subject: message.subject }),
		)
		return { delivered: false, skipped: true }
	}
	const apiBaseUrl = config.apiBaseUrl?.trim() || defaultApiBaseUrl
	const endpoint = new URL(
		`client/v4/accounts/${accountId}/email/sending/send`,
		apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`,
	)
	const fetcher = config.fetcher ?? fetch
	const replyTo = resolveTransactionalSenderReplyTo({
		from: message.from,
		replyTo: message.replyTo,
	})
	let response: Response
	try {
		response = await fetcher(endpoint.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(
				toCloudflareSendBody({
					from: message.from,
					to: message.to,
					subject: message.subject,
					text: message.text,
					html: message.html,
					replyTo,
				}),
			),
		})
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.warn('status-alert-email-request-failed', detail)
		return { delivered: false, error: detail }
	}
	const payload = (await response.json().catch(() => null)) as {
		success?: boolean
		errors?: Array<{ message?: string }>
	} | null
	if (!response.ok || payload?.success !== true) {
		const detail =
			payload?.errors?.[0]?.message ??
			`Cloudflare Email API returned HTTP ${response.status}.`
		console.warn(
			'status-alert-email-failed',
			JSON.stringify({ status: response.status, detail }),
		)
		return { delivered: false, error: detail }
	}
	return { delivered: true }
}
