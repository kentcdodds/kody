import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	type PackageWebhookChallenge,
	type PackageWebhookSubscriptionChallenge,
	webhookChallengeSecretName,
} from '#worker/package-registry/types.ts'
import { computeWebhookHmacSignature } from './crypto.ts'

export type WebhookChallengeConfig = PackageWebhookChallenge
export type NormalizedWebhookChallenge = PackageWebhookSubscriptionChallenge

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

function whenValueAllows(
	allowed: string | ReadonlyArray<string>,
	actual: string | null,
): boolean {
	if (actual == null) return false
	if (typeof allowed === 'string') return actual === allowed
	return allowed.includes(actual)
}

/**
 * Expand deprecated vendor-named challenge aliases into the canonical
 * `subscription-challenge` knobs. Prefer authoring the generic form directly.
 */
export function normalizeWebhookChallenge(
	challenge: PackageWebhookChallenge,
): NormalizedWebhookChallenge {
	switch (challenge.type) {
		case 'subscription-challenge':
			return challenge
		case 'x-activity-crc':
			return {
				type: 'subscription-challenge',
				method: 'GET',
				challenge: { in: 'query', key: 'crc_token' },
				prove: {
					kind: 'hmac',
					secretName: challenge.secretName,
					algorithm: 'hmac-sha256',
					encoding: 'base64',
					prefix: 'sha256=',
				},
				respond: { as: 'json-hmac', key: 'response_token' },
			}
		case 'websub-hub':
			return {
				type: 'subscription-challenge',
				method: 'GET',
				challenge: { in: 'query', key: 'hub.challenge' },
				when: {
					query: { 'hub.mode': ['subscribe', 'unsubscribe'] },
				},
				prove: challenge.secretName
					? {
							kind: 'verify-token',
							in: 'query',
							key: 'hub.verify_token',
							secretName: challenge.secretName,
							required: true,
						}
					: { kind: 'none' },
				respond: { as: 'text' },
			}
		case 'meta-hub':
			return {
				type: 'subscription-challenge',
				method: 'GET',
				challenge: { in: 'query', key: 'hub.challenge' },
				when: { query: { 'hub.mode': 'subscribe' } },
				prove: {
					kind: 'verify-token',
					in: 'query',
					key: 'hub.verify_token',
					secretName: challenge.secretName,
					required: true,
				},
				respond: { as: 'text' },
			}
		case 'strava-hub':
			return {
				type: 'subscription-challenge',
				method: 'GET',
				challenge: { in: 'query', key: 'hub.challenge' },
				when: { query: { 'hub.mode': 'subscribe' } },
				prove: {
					kind: 'verify-token',
					in: 'query',
					key: 'hub.verify_token',
					secretName: challenge.secretName,
					required: true,
				},
				respond: { as: 'json', key: 'hub.challenge' },
			}
		case 'slack-url-verification':
			return {
				type: 'subscription-challenge',
				method: 'POST',
				challenge: { in: 'json', key: 'challenge' },
				when: { json: { type: 'url_verification' } },
				prove: challenge.secretName
					? {
							kind: 'request-hmac',
							secretName: challenge.secretName,
							algorithm: 'hmac-sha256',
							encoding: 'hex',
							prefix: 'v0=',
							timestampHeader: 'x-slack-request-timestamp',
							signatureHeader: 'x-slack-signature',
							signedPayload: 'v0.timestamp.body',
						}
					: { kind: 'none' },
				respond: { as: 'json', key: 'challenge' },
			}
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

async function verifyRequestHmac(input: {
	request: Request
	bodyText: string
	prove: Extract<
		NonNullable<NormalizedWebhookChallenge['prove']>,
		{ kind: 'request-hmac' }
	>
	signingSecret: string
}): Promise<boolean> {
	const timestamp = input.request.headers.get(input.prove.timestampHeader)
	const provided = input.request.headers.get(input.prove.signatureHeader)
	if (!timestamp || !provided) return false
	if (!/^\d+$/.test(timestamp)) return false
	const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
	if (ageSeconds > 60 * 5) return false

	let signedString: string
	switch (input.prove.signedPayload) {
		case 'v0.timestamp.body':
			signedString = `v0:${timestamp}:${input.bodyText}`
			break
		default: {
			const exhaustive: never = input.prove.signedPayload
			throw new Error(
				`Unhandled request-hmac signedPayload: ${String(exhaustive)}`,
			)
		}
	}

	const base = new TextEncoder().encode(signedString)
	const expected = await computeWebhookHmacSignature({
		algorithm: input.prove.algorithm,
		secret: input.signingSecret,
		body: base.buffer.slice(
			base.byteOffset,
			base.byteOffset + base.byteLength,
		) as ArrayBuffer,
		encoding: input.prove.encoding,
		prefix: input.prove.prefix,
	})
	return timingSafeEqualString(expected, provided.trim())
}

function queryWhenMismatchResponse(
	key: string,
	allowed: string | ReadonlyArray<string>,
): Response {
	const allowedText =
		typeof allowed === 'string' ? allowed : allowed.join(' or ')
	return challengeBadRequestResponse(
		`Subscription challenge requires ${key}=${allowedText}.`,
	)
}

async function handleNormalizedSubscriptionChallenge(input: {
	request: Request
	challenge: NormalizedWebhookChallenge
	resolveSecret: (name: string) => Promise<string | null>
	bodyText?: string
}): Promise<WebhookChallengeHandleResult> {
	const config = input.challenge
	if (input.request.method !== config.method) {
		return { kind: 'not_challenge' }
	}

	const url = new URL(input.request.url)
	const params = url.searchParams

	let bodyJson: Record<string, unknown> | null = null
	let bodyText = input.bodyText

	if (config.method === 'POST' || config.challenge.in === 'json') {
		bodyText = bodyText ?? (await input.request.clone().text())
		try {
			const parsed: unknown = JSON.parse(bodyText)
			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed)
			) {
				bodyJson = parsed as Record<string, unknown>
			}
		} catch {
			bodyJson = null
		}
		if (config.method === 'POST' && bodyJson == null) {
			return { kind: 'not_challenge' }
		}
	}

	if (config.when?.query) {
		for (const [key, allowed] of Object.entries(config.when.query)) {
			const actual = params.get(key)
			if (!whenValueAllows(allowed, actual)) {
				if (config.method === 'POST') {
					return { kind: 'not_challenge' }
				}
				return {
					kind: 'respond',
					response: queryWhenMismatchResponse(key, allowed),
				}
			}
		}
	}

	if (config.when?.json) {
		if (bodyJson == null) {
			return config.method === 'POST'
				? { kind: 'not_challenge' }
				: {
						kind: 'respond',
						response: challengeBadRequestResponse(
							'Subscription challenge requires a JSON body.',
						),
					}
		}
		for (const [key, allowed] of Object.entries(config.when.json)) {
			const actual = bodyJson[key]
			if (typeof actual !== 'string' || actual !== allowed) {
				if (config.method === 'POST') {
					return { kind: 'not_challenge' }
				}
				return {
					kind: 'respond',
					response: challengeBadRequestResponse(
						`Subscription challenge requires JSON ${key}=${allowed}.`,
					),
				}
			}
		}
	}

	let challengeValue: string | null = null
	if (config.challenge.in === 'query') {
		challengeValue = params.get(config.challenge.key)
	} else {
		const raw = bodyJson?.[config.challenge.key]
		challengeValue = typeof raw === 'string' ? raw : null
	}

	if (
		config.method === 'GET' &&
		(challengeValue == null || challengeValue === '') &&
		config.when?.query == null
	) {
		// CRC-style: no filters, missing token is a bad request.
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				`Subscription challenge requires ${config.challenge.key}.`,
			),
		}
	}

	if (challengeValue == null || challengeValue === '') {
		if (config.method === 'POST') {
			// Without a matched when.json discriminator this is an ordinary
			// event POST — fall through. With when matched, the quiz is missing
			// its token field.
			const matchedJsonWhen =
				config.when?.json != null && Object.keys(config.when.json).length > 0
			if (!matchedJsonWhen) {
				return { kind: 'not_challenge' }
			}
			return {
				kind: 'respond',
				response: challengeBadRequestResponse(
					`Subscription challenge requires ${config.challenge.key}.`,
				),
			}
		}
		return {
			kind: 'respond',
			response: challengeBadRequestResponse(
				`Subscription challenge requires ${config.challenge.key}.`,
			),
		}
	}

	const tooLong = assertChallengeParamLength(
		challengeValue,
		config.challenge.key,
	)
	if (tooLong) return { kind: 'respond', response: tooLong }

	const prove = config.prove ?? { kind: 'none' as const }
	switch (prove.kind) {
		case 'none':
			break
		case 'verify-token': {
			const required = prove.required !== false
			const provided = params.get(prove.key) ?? ''
			const verifyTooLong = assertChallengeParamLength(provided, prove.key)
			if (verifyTooLong) {
				return { kind: 'respond', response: verifyTooLong }
			}
			if (!required && provided === '') break
			const secret = await resolveChallengeSecret({
				secretName: prove.secretName,
				resolveSecret: input.resolveSecret,
			})
			if (!secret.ok) return { kind: 'respond', response: secret.response }
			if (!(await timingSafeEqualString(provided, secret.value))) {
				return {
					kind: 'respond',
					response: challengeUnauthorizedResponse(
						'Subscription challenge verify token mismatch.',
					),
				}
			}
			break
		}
		case 'hmac': {
			const secret = await resolveChallengeSecret({
				secretName: prove.secretName,
				resolveSecret: input.resolveSecret,
			})
			if (!secret.ok) return { kind: 'respond', response: secret.response }
			const tokenBytes = new TextEncoder().encode(challengeValue)
			const digest = await computeWebhookHmacSignature({
				algorithm: prove.algorithm,
				secret: secret.value,
				body: tokenBytes.buffer.slice(
					tokenBytes.byteOffset,
					tokenBytes.byteOffset + tokenBytes.byteLength,
				) as ArrayBuffer,
				encoding: prove.encoding,
				prefix: prove.prefix,
			})
			if (config.respond.as !== 'json-hmac') {
				return {
					kind: 'respond',
					response: challengeBadRequestResponse(
						'HMAC prove requires respond.as=json-hmac.',
					),
				}
			}
			return {
				kind: 'respond',
				response: jsonResponse({ [config.respond.key]: digest }),
			}
		}
		case 'request-hmac': {
			const secret = await resolveChallengeSecret({
				secretName: prove.secretName,
				resolveSecret: input.resolveSecret,
			})
			if (!secret.ok) return { kind: 'respond', response: secret.response }
			const signatureOk = await verifyRequestHmac({
				request: input.request,
				bodyText: bodyText ?? '',
				prove,
				signingSecret: secret.value,
			})
			if (!signatureOk) {
				return {
					kind: 'respond',
					response: challengeUnauthorizedResponse(
						'Subscription challenge request signature verification failed.',
					),
				}
			}
			break
		}
		default: {
			const exhaustive: never = prove
			throw new Error(
				`Unhandled webhook challenge prove kind: ${String(
					(exhaustive as { kind?: string }).kind,
				)}`,
			)
		}
	}

	switch (config.respond.as) {
		case 'text':
			return { kind: 'respond', response: plainTextResponse(challengeValue) }
		case 'json':
			return {
				kind: 'respond',
				response: jsonResponse({ [config.respond.key]: challengeValue }),
			}
		case 'json-hmac':
			return {
				kind: 'respond',
				response: challengeBadRequestResponse(
					'respond.as=json-hmac requires prove.kind=hmac.',
				),
			}
		default: {
			const exhaustive: never = config.respond
			throw new Error(
				`Unhandled webhook challenge respond: ${String(
					(exhaustive as { as?: string }).as,
				)}`,
			)
		}
	}
}

/**
 * Answer a subscription-challenge probe on a minted webhook URL without
 * invoking package code. Returns `not_challenge` when the request should
 * continue on the normal delivery path (for example a POST after a body
 * quiz filter does not match).
 */
export async function handleWebhookSubscriptionChallenge(input: {
	request: Request
	challenge: WebhookChallengeConfig
	resolveSecret: (name: string) => Promise<string | null>
	/** Pre-read POST body when the caller already consumed the stream. */
	bodyText?: string
}): Promise<WebhookChallengeHandleResult> {
	return handleNormalizedSubscriptionChallenge({
		request: input.request,
		challenge: normalizeWebhookChallenge(input.challenge),
		resolveSecret: input.resolveSecret,
		bodyText: input.bodyText,
	})
}

export function webhookChallengeAllowsGet(
	challenge: WebhookChallengeConfig | null | undefined,
) {
	if (!challenge) return false
	return normalizeWebhookChallenge(challenge).method === 'GET'
}

export function webhookChallengeAllowsPost(
	challenge: WebhookChallengeConfig | null | undefined,
) {
	if (!challenge) return false
	return normalizeWebhookChallenge(challenge).method === 'POST'
}

export { webhookChallengeSecretName }
