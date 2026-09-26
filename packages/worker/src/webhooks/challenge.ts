import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type PackageWebhookChallenge } from '#worker/package-registry/types.ts'
import { computeWebhookHmacSignature } from './crypto.ts'

export type WebhookChallengeConfig = PackageWebhookChallenge

export type WebhookChallengeHandleResult =
	| { kind: 'not_challenge' }
	| { kind: 'respond'; response: Response }

/** Caps challenge query/body tokens so oversized probes cannot inflate HMAC work. */
export const webhookChallengeMaxParamChars = 4_096

function plainTextResponse(body: string, status = 200) {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}

function challengeUnauthorizedResponse(message: string) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_challenge',
				message,
			},
		},
		{ status: 401 },
	)
}

function challengeBadRequestResponse(message: string) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_challenge',
				message,
			},
		},
		{ status: 400 },
	)
}

function challengeParamTooLongResponse(paramName: string) {
	return challengeBadRequestResponse(
		`Challenge parameter "${paramName}" exceeds the ${webhookChallengeMaxParamChars}-character limit.`,
	)
}

function assertChallengeParamLength(
	value: string,
	paramName: string,
): Response | null {
	if (value.length > webhookChallengeMaxParamChars) {
		return challengeParamTooLongResponse(paramName)
	}
	return null
}

async function resolveChallengeSecret(input: {
	secretName: string
	resolveSecret: (name: string) => Promise<string | null>
}): Promise<{ ok: true; value: string } | { ok: false; response: Response }> {
	const value = await input.resolveSecret(input.secretName)
	if (value == null || value === '') {
		return {
			ok: false,
			response: challengeUnauthorizedResponse(
				'Challenge secret is missing or empty.',
			),
		}
	}
	return { ok: true, value }
}

/**
 * X Account Activity CRC: GET `crc_token` →
 * `{ response_token: "sha256=" + base64(hmac_sha256(token, secret)) }`.
 */
async function handleXActivityCrc(input: {
	request: Request
	secretName: string
	resolveSecret: (name: string) => Promise<string | null>
}): Promise<WebhookChallengeHandleResult> {
	if (input.request.method !== 'GET') return { kind: 'not_challenge' }
	const crcToken = new URL(input.request.url).searchParams.get('crc_token')
	if (crcToken == null || crcToken === '') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'X Activity CRC requires a crc_token query parameter.',
			),
		}
	}
	const tooLong = assertChallengeParamLength(crcToken, 'crc_token')
	if (tooLong) return { kind: 'respond', response: tooLong }
	const secret = await resolveChallengeSecret({
		secretName: input.secretName,
		resolveSecret: input.resolveSecret,
	})
	if (!secret.ok) return { kind: 'respond', response: secret.response }

	const tokenBytes = new TextEncoder().encode(crcToken)
	const digest = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: secret.value,
		body: tokenBytes.buffer.slice(
			tokenBytes.byteOffset,
			tokenBytes.byteOffset + tokenBytes.byteLength,
		) as ArrayBuffer,
		encoding: 'base64',
		prefix: 'sha256=',
	})
	return {
		kind: 'respond',
		response: jsonResponse({ response_token: digest }),
	}
}

/**
 * WebSub / YouTube hub challenge: echo `hub.challenge` as text/plain.
 * When `secretName` is set, `hub.verify_token` must match.
 */
async function handleWebsubHub(input: {
	request: Request
	secretName?: string
	resolveSecret: (name: string) => Promise<string | null>
}): Promise<WebhookChallengeHandleResult> {
	if (input.request.method !== 'GET') return { kind: 'not_challenge' }
	const params = new URL(input.request.url).searchParams
	const mode = params.get('hub.mode')
	const challenge = params.get('hub.challenge')
	if (mode == null && challenge == null) {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'WebSub hub challenge requires hub.mode and hub.challenge.',
			),
		}
	}
	if (mode !== 'subscribe' && mode !== 'unsubscribe') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'WebSub hub challenge requires hub.mode of subscribe or unsubscribe.',
			),
		}
	}
	if (challenge == null || challenge === '') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'WebSub hub challenge requires hub.challenge.',
			),
		}
	}
	const challengeTooLong = assertChallengeParamLength(
		challenge,
		'hub.challenge',
	)
	if (challengeTooLong) {
		return { kind: 'respond', response: challengeTooLong }
	}
	if (input.secretName) {
		const secret = await resolveChallengeSecret({
			secretName: input.secretName,
			resolveSecret: input.resolveSecret,
		})
		if (!secret.ok) return { kind: 'respond', response: secret.response }
		const verifyToken = params.get('hub.verify_token') ?? ''
		const verifyTooLong = assertChallengeParamLength(
			verifyToken,
			'hub.verify_token',
		)
		if (verifyTooLong) {
			return { kind: 'respond', response: verifyTooLong }
		}
		if (!(await timingSafeEqualString(verifyToken, secret.value))) {
			return {
				kind: 'respond',
				response: challengeUnauthorizedResponse(
					'WebSub hub verify token mismatch.',
				),
			}
		}
	}
	return { kind: 'respond', response: plainTextResponse(challenge) }
}

/**
 * Meta / Facebook / WhatsApp: GET hub.mode=subscribe + matching
 * hub.verify_token → echo hub.challenge as text/plain.
 */
async function handleMetaHub(input: {
	request: Request
	secretName: string
	resolveSecret: (name: string) => Promise<string | null>
}): Promise<WebhookChallengeHandleResult> {
	if (input.request.method !== 'GET') return { kind: 'not_challenge' }
	const params = new URL(input.request.url).searchParams
	const mode = params.get('hub.mode')
	const challenge = params.get('hub.challenge')
	const verifyToken = params.get('hub.verify_token') ?? ''
	if (mode == null && challenge == null && verifyToken === '') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'Meta hub challenge requires hub.mode, hub.verify_token, and hub.challenge.',
			),
		}
	}
	if (mode !== 'subscribe') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'Meta hub challenge requires hub.mode=subscribe.',
			),
		}
	}
	if (challenge == null || challenge === '') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'Meta hub challenge requires hub.challenge.',
			),
		}
	}
	const challengeTooLong = assertChallengeParamLength(
		challenge,
		'hub.challenge',
	)
	if (challengeTooLong) {
		return { kind: 'respond', response: challengeTooLong }
	}
	const verifyTooLong = assertChallengeParamLength(
		verifyToken,
		'hub.verify_token',
	)
	if (verifyTooLong) {
		return { kind: 'respond', response: verifyTooLong }
	}
	const secret = await resolveChallengeSecret({
		secretName: input.secretName,
		resolveSecret: input.resolveSecret,
	})
	if (!secret.ok) return { kind: 'respond', response: secret.response }
	if (!(await timingSafeEqualString(verifyToken, secret.value))) {
		return {
			kind: 'respond',
			response: challengeUnauthorizedResponse(
				'Meta hub verify token mismatch.',
			),
		}
	}
	return { kind: 'respond', response: plainTextResponse(challenge) }
}

async function verifySlackRequestSignature(input: {
	request: Request
	bodyText: string
	signingSecret: string
}): Promise<boolean> {
	const timestamp = input.request.headers.get('x-slack-request-timestamp')
	const provided = input.request.headers.get('x-slack-signature')
	if (!timestamp || !provided) return false
	if (!/^\d+$/.test(timestamp)) return false
	const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (ageSeconds > 60 * 5) return false
	const base = new TextEncoder().encode(`v0:${timestamp}:${input.bodyText}`)
	const expected = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: input.signingSecret,
		body: base.buffer.slice(
			base.byteOffset,
			base.byteOffset + base.byteLength,
		) as ArrayBuffer,
		encoding: 'hex',
		prefix: 'v0=',
	})
	return timingSafeEqualString(expected, provided.trim())
}

/**
 * Slack Events URL verification: POST `{ type: "url_verification", challenge }`
 * → `{ challenge }`. Other POSTs fall through to normal delivery.
 */
async function handleSlackUrlVerification(input: {
	request: Request
	secretName?: string
	resolveSecret: (name: string) => Promise<string | null>
	bodyText?: string
}): Promise<WebhookChallengeHandleResult> {
	if (input.request.method !== 'POST') return { kind: 'not_challenge' }
	const bodyText = input.bodyText ?? (await input.request.clone().text())
	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText) as unknown
	} catch {
		return { kind: 'not_challenge' }
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		Array.isArray(parsed) ||
		(parsed as { type?: unknown }).type !== 'url_verification'
	) {
		return { kind: 'not_challenge' }
	}
	const challenge = (parsed as { challenge?: unknown }).challenge
	if (typeof challenge !== 'string' || challenge === '') {
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				'Slack URL verification requires a challenge string.',
			),
		}
	}
	const tooLong = assertChallengeParamLength(challenge, 'challenge')
	if (tooLong) return { kind: 'respond', response: tooLong }
	if (input.secretName) {
		const secret = await resolveChallengeSecret({
			secretName: input.secretName,
			resolveSecret: input.resolveSecret,
		})
		if (!secret.ok) return { kind: 'respond', response: secret.response }
		const signatureOk = await verifySlackRequestSignature({
			request: input.request,
			bodyText,
			signingSecret: secret.value,
		})
		if (!signatureOk) {
			return {
				kind: 'respond',
				response: challengeUnauthorizedResponse(
					'Slack request signature verification failed.',
				),
			}
		}
	}
	return {
		kind: 'respond',
		response: jsonResponse({ challenge }),
	}
}

/**
 * Answer a subscription-challenge probe on a minted webhook URL without
 * invoking package code. Returns `not_challenge` when the request should
 * continue on the normal delivery path (for example a Slack event POST after
 * URL verification has already succeeded).
 */
export async function handleWebhookSubscriptionChallenge(input: {
	request: Request
	challenge: WebhookChallengeConfig
	resolveSecret: (name: string) => Promise<string | null>
	/** Pre-read POST body when the caller already consumed the stream. */
	bodyText?: string
}): Promise<WebhookChallengeHandleResult> {
	switch (input.challenge.type) {
		case 'x-activity-crc':
			return handleXActivityCrc({
				request: input.request,
				secretName: input.challenge.secretName,
				resolveSecret: input.resolveSecret,
			})
		case 'websub-hub':
			return handleWebsubHub({
				request: input.request,
				secretName: input.challenge.secretName,
				resolveSecret: input.resolveSecret,
			})
		case 'meta-hub':
			return handleMetaHub({
				request: input.request,
				secretName: input.challenge.secretName,
				resolveSecret: input.resolveSecret,
			})
		case 'slack-url-verification':
			return handleSlackUrlVerification({
				request: input.request,
				secretName: input.challenge.secretName,
				resolveSecret: input.resolveSecret,
				bodyText: input.bodyText,
			})
		default: {
			const exhaustive: never = input.challenge
			throw new Error(
				`Unhandled webhook challenge type: ${String(
					(exhaustive as { type?: string }).type,
				)}`,
			)
		}
	}
}

export function webhookChallengeAllowsGet(
	challenge: WebhookChallengeConfig | null | undefined,
) {
	if (!challenge) return false
	switch (challenge.type) {
		case 'x-activity-crc':
		case 'websub-hub':
		case 'meta-hub':
			return true
		case 'slack-url-verification':
			return false
		default: {
			const exhaustive: never = challenge
			throw new Error(
				`Unhandled webhook challenge type: ${String(
					(exhaustive as { type?: string }).type,
				)}`,
			)
		}
	}
}
