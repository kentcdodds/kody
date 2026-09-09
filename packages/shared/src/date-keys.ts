const isoDayKeyLength = 'YYYY-MM-DD'.length
const isoMonthKeyLength = 'YYYY-MM'.length
const utcDayMs = 24 * 60 * 60 * 1000

/** UTC calendar day key, for example `2026-07-08`. */
export function utcDayKey(date: Date = new Date()) {
	return date.toISOString().slice(0, isoDayKeyLength)
}

/**
 * UTC Monday that starts the week containing `date`, for example
 * `2026-07-06` for Sunday 2026-07-12.
 */
export function utcWeekStart(date: Date = new Date()) {
	const daysSinceMonday = (date.getUTCDay() + 6) % 7
	return utcDayKey(new Date(date.getTime() - daysSinceMonday * utcDayMs))
}

/** UTC calendar month key, for example `2026-07`. */
export function utcMonthKey(date: Date = new Date()) {
	return date.toISOString().slice(0, isoMonthKeyLength)
}

/** Day key of an ISO 8601 UTC timestamp string, for example `2026-07-08`. */
export function isoTimestampDayKey(isoTimestamp: string) {
	return isoTimestamp.slice(0, isoDayKeyLength)
}

const sqliteTimestampLength = 'YYYY-MM-DD HH:MM:SS'.length

/**
 * UTC timestamp matching SQLite's CURRENT_TIMESTAMP format, for example
 * `2026-07-08 07:41:00`. Use for columns whose schema default is
 * CURRENT_TIMESTAMP so values written from JS sort consistently with values
 * written by the database.
 */
export function utcSqliteTimestamp(date: Date = new Date()) {
	return date.toISOString().replace('T', ' ').slice(0, sqliteTimestampLength)
}
