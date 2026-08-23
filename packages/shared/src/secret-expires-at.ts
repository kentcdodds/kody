/**
 * Normalize optional secret expiry. Empty / null means no expiry. Otherwise
 * require a UTC ISO timestamp (or a YYYY-MM-DD calendar date, stored as
 * midnight UTC) and return canonical ISO form.
 */
export function normalizeSecretExpiresAt(
	expiresAt: string | null | undefined,
): string | null {
	if (expiresAt == null) return null
	const trimmed = expiresAt.trim()
	if (!trimmed) return null
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return parseUtcIsoTimestamp(`${trimmed}T00:00:00.000Z`).toISOString()
	}
	return parseUtcIsoTimestamp(trimmed).toISOString()
}

export function earliestSecretExpiresAt(
	...values: Array<string | null | undefined>
): string | null {
	let earliest: string | null = null
	for (const value of values) {
		if (value == null) continue
		if (earliest == null || value < earliest) earliest = value
	}
	return earliest
}

export function isSecretExpired(
	expiresAt: string | null | undefined,
	now = new Date(),
) {
	if (expiresAt == null) return false
	const expiresAtMs = new Date(expiresAt).valueOf()
	if (!Number.isFinite(expiresAtMs)) return false
	return expiresAtMs <= now.valueOf()
}

export function secretTtlMs(
	expiresAt: string | null | undefined,
	now = new Date(),
): number | null {
	if (expiresAt == null) return null
	return Math.max(0, new Date(expiresAt).valueOf() - now.valueOf())
}

export function nextSecretExpiresAt(input: {
	existing: string | null | undefined
	requested: string | null | undefined
}): string | null {
	if (input.requested === undefined) return input.existing ?? null
	return normalizeSecretExpiresAt(input.requested)
}

export function toDatetimeLocalValue(expiresAt: string | null | undefined) {
	if (expiresAt == null || expiresAt.trim() === '') return ''
	const parsed = new Date(expiresAt)
	if (Number.isNaN(parsed.valueOf())) return ''
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

export function fromDatetimeLocalValue(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return ''
	const parsed = new Date(trimmed)
	if (Number.isNaN(parsed.valueOf())) {
		throw new Error(
			'Expiry must be a valid date and time, or empty for no expiry.',
		)
	}
	return parsed.toISOString()
}

function parseUtcIsoTimestamp(value: string) {
	if (!/(?:Z|[+-]00:00)$/i.test(value)) {
		throw new Error(
			'expires_at must use an ISO 8601 UTC timestamp (for example 2026-12-01T00:00:00Z).',
		)
	}
	const calendarMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T/)
	if (calendarMatch?.[1] && calendarMatch[2] && calendarMatch[3]) {
		const year = Number.parseInt(calendarMatch[1], 10)
		const month = Number.parseInt(calendarMatch[2], 10)
		const day = Number.parseInt(calendarMatch[3], 10)
		const reconstructed = new Date(Date.UTC(year, month - 1, day))
		if (
			reconstructed.getUTCFullYear() !== year ||
			reconstructed.getUTCMonth() !== month - 1 ||
			reconstructed.getUTCDate() !== day
		) {
			throw new Error('expires_at requires a valid ISO 8601 calendar date.')
		}
	}
	const parsed = new Date(value)
	if (Number.isNaN(parsed.valueOf())) {
		throw new Error('expires_at requires a valid ISO 8601 timestamp.')
	}
	return parsed
}
