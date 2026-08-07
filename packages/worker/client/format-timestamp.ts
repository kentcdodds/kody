/**
 * SQLite CURRENT_TIMESTAMP is `YYYY-MM-DD HH:MM:SS` (UTC); the space separator
 * is not valid ISO 8601 so Safari rejects it without the `T`, and the `Z` marks
 * the value as UTC instead of local time.
 */
function parseDbTimestamp(value: string) {
	return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
}

/** Format a DB timestamp for display in the user's locale. */
export function formatTimestamp(value: string) {
	const date = parseDbTimestamp(value)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/**
 * Date without the time, for table cells that have room for one token. Shares
 * the normalization above — `new Date(value)` on a raw DB timestamp renders
 * "Invalid Date" in Safari and shifts the day everywhere else.
 */
export function formatTimestampDate(value: string) {
	const date = parseDbTimestamp(value)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function formatNullableTimestamp(
	value: string | null,
	fallback = 'Never',
) {
	return value ? formatTimestamp(value) : fallback
}
