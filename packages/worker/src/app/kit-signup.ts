/**
 * Kit (kit.com) signup tagging helpers.
 *
 * When someone creates a Kody account and already exists as a Kit subscriber
 * (for example from the public waitlist), tag them `signed_up::kody`. Existing
 * tags such as `waitlist::kody` are left alone — Kit tags are additive.
 *
 * Auth uses the `X-Kit-Api-Key` header against `https://api.kit.com/v4`.
 */

import { KIT_API_BASE_URL } from '#app/kit-waitlist.ts'

/** Kit tag `signed_up::kody` — override with `KIT_SIGNED_UP_TAG_ID` if needed. */
export const DEFAULT_KIT_SIGNED_UP_TAG_ID = 21252175

/** Bound Kit round-trips so a hung upstream cannot pin a Worker request. */
export const KIT_SIGNUP_REQUEST_TIMEOUT_MS = 8_000

export type TagExistingKitSubscriberOnSignupInput = {
	apiKey: string
	email: string
	tagId?: number
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

export type TagExistingKitSubscriberOnSignupResult =
	| { tagged: true; subscriberId: number }
	| { tagged: false; reason: 'not_found' }

export class KitSignupError extends Error {
	readonly status: number | null
	readonly kind: 'client' | 'server' | 'network'

	constructor(
		message: string,
		options: { status?: number | null; kind: KitSignupError['kind'] },
	) {
		super(message)
		this.name = 'KitSignupError'
		this.status = options.status ?? null
		this.kind = options.kind
	}
}

type KitSubscriber = {
	id?: number
	email_address?: string
}

type KitSubscriberPayload = {
	subscriber?: KitSubscriber
	subscribers?: Array<KitSubscriber>
	errors?: Array<string>
}

function kitHeaders(apiKey: string): HeadersInit {
	return {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-Kit-Api-Key': apiKey,
	}
}

async function readKitJson(
	response: Response,
): Promise<KitSubscriberPayload | null> {
	try {
		return (await response.json()) as KitSubscriberPayload
	} catch {
		return null
	}
}

function kitErrorMessage(
	payload: KitSubscriberPayload | null,
	fallback: string,
) {
	const first = payload?.errors?.[0]
	return typeof first === 'string' && first.trim() ? first : fallback
}

function classifyHttpKind(status: number): 'client' | 'server' {
	return status >= 500 ? 'server' : 'client'
}

function isAbortError(error: unknown) {
	return (
		(error instanceof DOMException && error.name === 'TimeoutError') ||
		(error instanceof Error && error.name === 'AbortError')
	)
}

async function kitFetch(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	try {
		return await fetchImpl(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		if (isAbortError(error)) {
			throw new KitSignupError('Kit request timed out.', {
				status: null,
				kind: 'network',
			})
		}
		throw new KitSignupError('Kit request failed.', {
			status: null,
			kind: 'network',
		})
	}
}

/**
 * If the email already exists in Kit, apply the signed-up tag. Does not create
 * subscribers and does not remove other tags (including waitlist).
 */
export async function tagExistingKitSubscriberOnSignup(
	input: TagExistingKitSubscriberOnSignupInput,
): Promise<TagExistingKitSubscriberOnSignupResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const tagId = input.tagId ?? DEFAULT_KIT_SIGNED_UP_TAG_ID
	const timeoutMs = input.timeoutMs ?? KIT_SIGNUP_REQUEST_TIMEOUT_MS
	const headers = kitHeaders(input.apiKey)

	const lookupUrl = `${KIT_API_BASE_URL}/subscribers?email_address=${encodeURIComponent(input.email)}`
	const lookupResponse = await kitFetch(
		fetchImpl,
		lookupUrl,
		{ method: 'GET', headers },
		timeoutMs,
	)
	const lookupPayload = await readKitJson(lookupResponse)
	if (!lookupResponse.ok) {
		throw new KitSignupError(
			kitErrorMessage(
				lookupPayload,
				`Kit subscriber lookup failed (${lookupResponse.status}).`,
			),
			{
				status: lookupResponse.status,
				kind: classifyHttpKind(lookupResponse.status),
			},
		)
	}

	const existing = lookupPayload?.subscribers?.find(
		(subscriber) => typeof subscriber.id === 'number',
	)
	if (typeof existing?.id !== 'number') {
		return { tagged: false, reason: 'not_found' }
	}

	const tagResponse = await kitFetch(
		fetchImpl,
		`${KIT_API_BASE_URL}/tags/${tagId}/subscribers`,
		{
			method: 'POST',
			headers,
			body: JSON.stringify({
				email_address: input.email,
			}),
		},
		timeoutMs,
	)
	const tagPayload = await readKitJson(tagResponse)
	if (!tagResponse.ok) {
		throw new KitSignupError(
			kitErrorMessage(
				tagPayload,
				`Kit signed-up tag failed (${tagResponse.status}).`,
			),
			{
				status: tagResponse.status,
				kind: classifyHttpKind(tagResponse.status),
			},
		)
	}

	return { tagged: true, subscriberId: existing.id }
}

function resolvePositiveIntId(
	raw: string | undefined,
	fallback: number,
): number | null {
	if (raw === undefined) return fallback
	const trimmed = raw.trim()
	if (!trimmed) return fallback
	if (!/^\d+$/.test(trimmed)) return null
	const parsed = Number.parseInt(trimmed, 10)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
	return parsed
}

export function resolveKitSignedUpTagId(
	raw: string | undefined,
): number | null {
	return resolvePositiveIntId(raw, DEFAULT_KIT_SIGNED_UP_TAG_ID)
}

/**
 * Best-effort signup side effect: when Kit is configured and the email already
 * exists there, apply `signed_up::kody`. Failures are logged and never thrown.
 */
export async function maybeTagKitSubscriberOnSignup(input: {
	env: Pick<Env, 'KIT_API_KEY' | 'KIT_SIGNED_UP_TAG_ID'>
	email: string
	fetchImpl?: typeof fetch
}): Promise<void> {
	const apiKey = input.env.KIT_API_KEY?.trim()
	if (!apiKey) return

	const tagId = resolveKitSignedUpTagId(input.env.KIT_SIGNED_UP_TAG_ID)
	if (tagId === null) {
		console.warn(
			'Skipping Kit signed-up tagging: KIT_SIGNED_UP_TAG_ID is invalid.',
		)
		return
	}

	try {
		await tagExistingKitSubscriberOnSignup({
			apiKey,
			email: input.email,
			tagId,
			fetchImpl: input.fetchImpl,
		})
	} catch (error) {
		console.warn('Failed to tag Kit subscriber on signup:', error)
	}
}
