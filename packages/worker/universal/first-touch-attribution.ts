/**
 * First-touch marketing attribution captured at signup (email or OAuth).
 * Invite codes remain the access key; these fields are the acquisition story.
 * Values are write-once on the user row — never overwrite later UTMs.
 */

export type FirstTouchAttribution = {
	utmSource: string | null
	utmMedium: string | null
	utmCampaign: string | null
	utmContent: string | null
	utmTerm: string | null
	landingPath: string | null
	referrer: string | null
}

export const emptyFirstTouchAttribution: FirstTouchAttribution = {
	utmSource: null,
	utmMedium: null,
	utmCampaign: null,
	utmContent: null,
	utmTerm: null,
	landingPath: null,
	referrer: null,
}

const maxAttributionValueLength = 200
const maxLandingPathLength = 500
const maxReferrerLength = 500

/**
 * Homepage CTA query so Fathom channel reports are not empty for organic
 * site traffic that starts signup from kody.codes.
 */
export const homepageSignupAttributionQuery =
	'utm_source=kody.codes&utm_medium=homepage&utm_campaign=signup'

export const homepageSignupPath = `/signup?${homepageSignupAttributionQuery}`

export function normalizeAttributionValue(
	value: unknown,
	maxLength = maxAttributionValueLength,
): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.slice(0, maxLength)
}

export function normalizeLandingPath(value: unknown): string | null {
	const raw = normalizeAttributionValue(value, maxLandingPathLength)
	if (!raw) return null
	if (!raw.startsWith('/')) return null
	if (raw.startsWith('//')) return null
	return raw
}

export function normalizeReferrer(value: unknown): string | null {
	return normalizeAttributionValue(value, maxReferrerLength)
}

export function hasFirstTouchAttribution(
	value: FirstTouchAttribution | null | undefined,
): boolean {
	if (!value) return false
	return (
		value.utmSource != null ||
		value.utmMedium != null ||
		value.utmCampaign != null ||
		value.utmContent != null ||
		value.utmTerm != null ||
		value.landingPath != null ||
		value.referrer != null
	)
}

export function parseFirstTouchAttribution(input: {
	searchParams?: URLSearchParams | null
	landingPath?: unknown
	referrer?: unknown
	body?: unknown
}): FirstTouchAttribution {
	const fromBody =
		input.body && typeof input.body === 'object'
			? (input.body as Record<string, unknown>)
			: null
	const params = input.searchParams ?? null

	function readParam(key: string, bodyKeys: Array<string>) {
		const fromQuery = params?.get(key)
		if (fromQuery != null && fromQuery.trim()) {
			return normalizeAttributionValue(fromQuery)
		}
		if (!fromBody) return null
		for (const bodyKey of bodyKeys) {
			const normalized = normalizeAttributionValue(fromBody[bodyKey])
			if (normalized) return normalized
		}
		return null
	}

	const landingPath =
		normalizeLandingPath(input.landingPath) ??
		normalizeLandingPath(params?.get('landing_path')) ??
		normalizeLandingPath(fromBody?.landingPath) ??
		normalizeLandingPath(fromBody?.landing_path)

	const referrer =
		normalizeReferrer(input.referrer) ??
		normalizeReferrer(params?.get('referrer')) ??
		normalizeReferrer(fromBody?.referrer) ??
		normalizeReferrer(fromBody?.firstTouchReferrer)

	return {
		utmSource: readParam('utm_source', ['utmSource', 'utm_source']),
		utmMedium: readParam('utm_medium', ['utmMedium', 'utm_medium']),
		utmCampaign: readParam('utm_campaign', ['utmCampaign', 'utm_campaign']),
		utmContent: readParam('utm_content', ['utmContent', 'utm_content']),
		utmTerm: readParam('utm_term', ['utmTerm', 'utm_term']),
		landingPath,
		referrer,
	}
}

/**
 * Flatten attribution into JSON-safe fields for the OAuth login-state cookie
 * and signup POST body (camelCase, omit nulls).
 */
export function serializeFirstTouchAttributionForTransport(
	attribution: FirstTouchAttribution | null | undefined,
): Record<string, string> {
	if (!hasFirstTouchAttribution(attribution) || !attribution) return {}
	const out: Record<string, string> = {}
	if (attribution.utmSource) out.utmSource = attribution.utmSource
	if (attribution.utmMedium) out.utmMedium = attribution.utmMedium
	if (attribution.utmCampaign) out.utmCampaign = attribution.utmCampaign
	if (attribution.utmContent) out.utmContent = attribution.utmContent
	if (attribution.utmTerm) out.utmTerm = attribution.utmTerm
	if (attribution.landingPath) out.landingPath = attribution.landingPath
	if (attribution.referrer) out.referrer = attribution.referrer
	return out
}

export function firstTouchAttributionToUserColumns(
	attribution: FirstTouchAttribution | null | undefined,
): {
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
} {
	const value = attribution ?? emptyFirstTouchAttribution
	return {
		utm_source: value.utmSource,
		utm_medium: value.utmMedium,
		utm_campaign: value.utmCampaign,
		utm_content: value.utmContent,
		utm_term: value.utmTerm,
		first_touch_landing_path: value.landingPath,
		first_touch_referrer: value.referrer,
	}
}

/**
 * Columns to pass into `db.create(usersTable, …)`. The ORM treats optional
 * text columns as `string | undefined` (omit) rather than SQL NULL, so absent
 * attribution fields are dropped instead of set to null.
 */
export function firstTouchAttributionCreateFields(
	attribution: FirstTouchAttribution | null | undefined,
): Partial<{
	utm_source: string
	utm_medium: string
	utm_campaign: string
	utm_content: string
	utm_term: string
	first_touch_landing_path: string
	first_touch_referrer: string
}> {
	const columns = firstTouchAttributionToUserColumns(attribution)
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(columns)) {
		if (typeof value === 'string' && value.length > 0) {
			out[key] = value
		}
	}
	return out
}

/** Append standard utm_* / landing_path / referrer keys for OAuth start URLs. */
export function appendAttributionQueryParams(
	params: URLSearchParams,
	attribution: FirstTouchAttribution | null | undefined,
) {
	if (!hasFirstTouchAttribution(attribution) || !attribution) return
	if (attribution.utmSource) params.set('utm_source', attribution.utmSource)
	if (attribution.utmMedium) params.set('utm_medium', attribution.utmMedium)
	if (attribution.utmCampaign)
		params.set('utm_campaign', attribution.utmCampaign)
	if (attribution.utmContent) params.set('utm_content', attribution.utmContent)
	if (attribution.utmTerm) params.set('utm_term', attribution.utmTerm)
	if (attribution.landingPath)
		params.set('landing_path', attribution.landingPath)
	if (attribution.referrer) params.set('referrer', attribution.referrer)
}
