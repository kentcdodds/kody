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

export type KitWaitlistSubscribeInput = {
	apiKey: string
	email: string
	firstName: string
	tagId?: number
	fetchImpl?: typeof fetch
}

export type KitWaitlistSubscribeResult = {
	subscriberId: number
}

type KitSubscriberPayload = {
	subscriber?: {
		id?: number
		email_address?: string
		first_name?: string
	}
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

/**
 * Upsert a Kit subscriber (email + first name) and tag them for the Kody
 * waitlist. Tagging is idempotent; create is an upsert by email.
 */
export async function subscribeToKitWaitlist(
	input: KitWaitlistSubscribeInput,
): Promise<KitWaitlistSubscribeResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	const tagId = input.tagId ?? DEFAULT_KIT_WAITLIST_TAG_ID
	const headers = kitHeaders(input.apiKey)

	const createResponse = await fetchImpl(`${KIT_API_BASE_URL}/subscribers`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			email_address: input.email,
			first_name: input.firstName,
		}),
	})
	const createPayload = await readKitJson(createResponse)
	if (!createResponse.ok) {
		throw new Error(
			kitErrorMessage(
				createPayload,
				`Kit subscriber create failed (${createResponse.status}).`,
			),
		)
	}

	const subscriberId = createPayload?.subscriber?.id
	if (typeof subscriberId !== 'number') {
		throw new Error('Kit subscriber create returned no subscriber id.')
	}

	const tagResponse = await fetchImpl(
		`${KIT_API_BASE_URL}/tags/${tagId}/subscribers`,
		{
			method: 'POST',
			headers,
			body: JSON.stringify({
				email_address: input.email,
			}),
		},
	)
	const tagPayload = await readKitJson(tagResponse)
	if (!tagResponse.ok) {
		throw new Error(
			kitErrorMessage(
				tagPayload,
				`Kit waitlist tag failed (${tagResponse.status}).`,
			),
		)
	}

	return { subscriberId }
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
