import { parseSafe } from 'remix/data-schema'
import {
	outboundEmailSchema,
	type OutboundEmail,
} from '@kody-internal/shared/outbound-email.ts'

type CloudflareEmailClientConfig = {
	accountId?: string
	apiBaseUrl?: string
	apiToken?: string
}

type CloudflareApiEnvelope = {
	success: boolean
	errors?: Array<{
		code?: number | string
		message?: string
	}>
	result?: {
		messageId?: string
	}
}

type CloudflareSendResult = {
	ok: boolean
	id?: string
	skipped?: boolean
	error?: string
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

function logSkippedEmail(reason: string, message: OutboundEmail) {
	console.warn(
		reason,
		JSON.stringify({
			to: message.to,
			from: message.from,
			subject: message.subject,
			html: message.html,
			text: message.text,
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
		`client/v4/accounts/${config.accountId}/email-service/send`,
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
		id:
			typeof payload?.result?.messageId === 'string'
				? payload.result.messageId
				: undefined,
	}
}

export async function sendCloudflareEmail(
	config: CloudflareEmailClientConfig,
	message: OutboundEmail,
): Promise<CloudflareSendResult> {
	const normalized = normalizeEmailPayload(message)
	const hasApiConfig =
		typeof config.apiBaseUrl === 'string' &&
		config.apiBaseUrl.trim().length > 0 &&
		typeof config.apiToken === 'string' &&
		config.apiToken.trim().length > 0 &&
		typeof config.accountId === 'string' &&
		config.accountId.trim().length > 0

	if (hasApiConfig) {
		return sendViaCloudflareApi(
			{
				accountId: config.accountId!.trim(),
				apiBaseUrl: config.apiBaseUrl!.trim(),
				apiToken: config.apiToken!.trim(),
			},
			normalized,
		)
	}

	logSkippedEmail('cloudflare-email-unconfigured', normalized)
	return { ok: false, skipped: true }
}
