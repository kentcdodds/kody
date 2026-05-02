import { parseSafe } from 'remix/data-schema'
import {
	outboundEmailSchema,
	type OutboundEmail,
} from '@kody-internal/shared/outbound-email.ts'
import { redactEmailRecipient } from '#app/audit-log.ts'

type CloudflareEmailClientConfig = {
	accountId?: string
	apiBaseUrl?: string
	apiToken?: string
}

const defaultCloudflareApiBaseUrl = 'https://api.cloudflare.com'

type CloudflareApiEnvelope = {
	success: boolean
	errors?: Array<{
		code?: number | string
		message?: string
	}>
	result?: {
		message_id?: string
		delivered?: string[]
		permanent_bounces?: string[]
		queued?: string[]
	}
}

type CloudflareSendResult = {
	ok: boolean
	skipped?: boolean
	error?: string
	messageId?: string | null
}

function normalizeEmailPayload(message: OutboundEmail) {
	const result = parseSafe(outboundEmailSchema, message)
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
		throw new Error(`Invalid outbound email payload: ${issueMessage}`)
	}
	return result.value
}

function redactRecipients(to: string | Array<string>) {
	if (Array.isArray(to)) return to.map(redactEmailRecipient)
	return redactEmailRecipient(to)
}

function logSkippedEmail(reason: string, message: OutboundEmail) {
	console.warn(
		reason,
		JSON.stringify({
			to: redactRecipients(message.to),
			from: message.from,
			subject: message.subject,
		}),
	)
}

function normalizeApiBaseUrl(apiBaseUrl: string) {
	return apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
}

async function sendViaCloudflareApi(
	config: Required<
		Pick<CloudflareEmailClientConfig, 'accountId' | 'apiBaseUrl' | 'apiToken'>
	>,
	message: OutboundEmail,
): Promise<CloudflareSendResult> {
	const endpoint = new URL(
		`client/v4/accounts/${config.accountId}/email/sending/send`,
		normalizeApiBaseUrl(config.apiBaseUrl),
	)
	let response: Response
	try {
		response = await fetch(endpoint.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(message),
		})
	} catch (error) {
		console.warn('cloudflare-email-api-request-failed', error)
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: 'Cloudflare Email API request failed.',
		}
	}

	const payload = (await response
		.json()
		.catch(() => null)) as CloudflareApiEnvelope | null
	if (!response.ok || payload?.success !== true) {
		console.warn(
			'cloudflare-email-api-failed',
			JSON.stringify({
				status: response.status,
				body: payload,
				to: message.to,
				from: message.from,
				subject: message.subject,
			}),
		)
		return {
			ok: false,
			error:
				payload?.errors?.[0]?.message ??
				'Cloudflare Email API returned an error response.',
		}
	}

	return {
		ok: true,
		messageId: payload.result?.message_id ?? null,
	}
}

export async function sendCloudflareEmail(
	config: CloudflareEmailClientConfig,
	message: Omit<OutboundEmail, 'replyTo' | 'headers'> &
		Partial<Pick<OutboundEmail, 'replyTo' | 'headers'>>,
): Promise<CloudflareSendResult> {
	const normalized = normalizeEmailPayload({
		...message,
		replyTo: message.replyTo,
		headers: message.headers,
	})
	const apiBaseUrl =
		typeof config.apiBaseUrl === 'string' && config.apiBaseUrl.trim().length > 0
			? config.apiBaseUrl.trim()
			: defaultCloudflareApiBaseUrl
	const hasApiConfig =
		typeof config.apiToken === 'string' &&
		config.apiToken.trim().length > 0 &&
		typeof config.accountId === 'string' &&
		config.accountId.trim().length > 0

	if (hasApiConfig) {
		return sendViaCloudflareApi(
			{
				accountId: config.accountId!.trim(),
				apiBaseUrl,
				apiToken: config.apiToken!.trim(),
			},
			normalized,
		)
	}

	logSkippedEmail('cloudflare-email-unconfigured', normalized)
	return { ok: false, skipped: true }
}
