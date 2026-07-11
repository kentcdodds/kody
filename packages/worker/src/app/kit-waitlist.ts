/**
 * Kit (kit.com) waitlist subscriber helpers.
 *
 * Auth uses the `X-Kit-Api-Key` header against `https://api.kit.com/v4`.
 * Public signup captures join the `waitlist::kody` tag (created in Kit for
 * this product). Forms cannot be created via the API, and Kent's existing
 * waitlists use the `waitlist::…` tag convention, so tagging is the right
 * integration surface.
 */

export const KIT_API_BASE_URL = 'https://api.kit.com/v4'

/** Kit tag `waitlist::kody` — override with `KIT_WAITLIST_TAG_ID` if needed. */
export const DEFAULT_KIT_WAITLIST_TAG_ID = 21081721

/** Bound Kit round-trips so a hung upstream cannot pin a Worker request. */
export const KIT_WAITLIST_REQUEST_TIMEOUT_MS = 8_000

export type KitWaitlistSubscribeInput = {
	apiKey: string
	email: string
	firstName: string
	tagId?: number
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

export type KitWaitlistSubscribeResult = {
	subscriberId: number
	created: boolean
}

type KitSubscriber = {
	id?: number
	email_address?: string
	first_name?: string
}

type KitSubscriberPayload = {
	subscriber?: KitSubscriber
	subscribers?: Array<KitSubscriber>
	errors?: Array<string>
}

export class KitWaitlistError extends Error {
	readonly status: number | null
	readonly kind: 'client' | 'server' | 'network'

	constructor(
		message: string,
		options: { status?: number | null; kind: KitWaitlistError['kind'] },
	) {
		super(message)
		this.name = 'KitWaitlistError'
		this.status = options.status ?? null
		this.kind = options.kind
	}
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
			throw new KitWaitlistError('Kit request timed out.', {
				status: null,
				kind: 'network',
			})
		}
		throw new KitWaitlistError('Kit request failed.', {
			status: null,
			kind: 'network',
		})
	}
}

/**
 * Find an existing Kit subscriber by email, tag them for the waitlist, and
 * only create (with first_name) when they are new. Existing CRM names are
 * never overwritten by a public waitlist submission.
 */
export async function subscribeToKitWaitlist(
	input: KitWaitlistSubscribeInput,
): Promise<KitWaitlistSubscribeResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const tagId = input.tagId ?? DEFAULT_KIT_WAITLIST_TAG_ID
	const timeoutMs = input.timeoutMs ?? KIT_WAITLIST_REQUEST_TIMEOUT_MS
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
		throw new KitWaitlistError(
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
	let subscriberId = existing?.id
	let created = false

	if (typeof subscriberId !== 'number') {
		const createResponse = await kitFetch(
			fetchImpl,
			`${KIT_API_BASE_URL}/subscribers`,
			{
				method: 'POST',
				headers,
				body: JSON.stringify({
					email_address: input.email,
					first_name: input.firstName,
				}),
			},
			timeoutMs,
		)
		const createPayload = await readKitJson(createResponse)
		if (!createResponse.ok) {
			throw new KitWaitlistError(
				kitErrorMessage(
					createPayload,
					`Kit subscriber create failed (${createResponse.status}).`,
				),
				{
					status: createResponse.status,
					kind: classifyHttpKind(createResponse.status),
				},
			)
		}
		subscriberId = createPayload?.subscriber?.id
		created = true
		if (typeof subscriberId !== 'number') {
			throw new KitWaitlistError(
				'Kit subscriber create returned no subscriber id.',
				{ status: createResponse.status, kind: 'server' },
			)
		}
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
		throw new KitWaitlistError(
			kitErrorMessage(
				tagPayload,
				`Kit waitlist tag failed (${tagResponse.status}).`,
			),
			{
				status: tagResponse.status,
				kind: classifyHttpKind(tagResponse.status),
			},
		)
	}

	return { subscriberId, created }
}

export function resolveKitWaitlistTagId(
	raw: string | undefined,
): number | null {
	if (raw === undefined) return DEFAULT_KIT_WAITLIST_TAG_ID
	const trimmed = raw.trim()
	if (!trimmed) return DEFAULT_KIT_WAITLIST_TAG_ID
	if (!/^\d+$/.test(trimmed)) return null
	const parsed = Number.parseInt(trimmed, 10)
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
	return parsed
}
