import { parseSafe } from 'remix/data-schema'
import {
	outboundEmailSchema,
	type OutboundEmail,
} from '@kody-internal/shared/outbound-email.ts'

type CloudflareEmailBindingResponse = {
	messageId: string
	success: boolean
}

export type CloudflareEmailBinding = {
	send(
		message: OutboundEmail,
	): Promise<CloudflareEmailBindingResponse | void>
}

type CloudflareEmailClientConfig = {
	accountId?: string
	apiBaseUrl?: string
	apiToken?: string
	binding?: CloudflareEmailBinding
	isLocalDev?: boolean
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
			body: message.html,
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
	const response = await fetch(endpoint.toString(), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(message),
	})
	const payload = (await response
		.json()
		.catch(() => null)) as CloudflareApiEnvelope | null
	if (!response.ok || payload?.success === false) {
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

async function sendViaBinding(
	binding: CloudflareEmailBinding,
	message: OutboundEmail,
): Promise<CloudflareSendResult> {
	try {
		const response = await binding.send(message)
		const hasResponse =
			typeof response === 'object' &&
			response !== null &&
			'success' in response
		const success = hasResponse
			? (response as CloudflareEmailBindingResponse).success !== false
			: true
		const messageId = hasResponse
			? (response as CloudflareEmailBindingResponse).messageId
			: undefined
		return {
			ok: success,
			id: messageId,
			error: success ? undefined : 'Cloudflare Email binding failed.',
		}
	} catch (error) {
		console.warn('cloudflare-email-binding-failed', error)
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: 'Cloudflare Email binding failed.',
		}
	}
}

export async function sendCloudflareEmail(
	config: CloudflareEmailClientConfig,
	message: OutboundEmail,
): Promise<CloudflareSendResult> {
	const normalized = normalizeEmailPayload(message)
	if (config.binding && !config.isLocalDev) {
		return sendViaBinding(config.binding, normalized)
	}

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
