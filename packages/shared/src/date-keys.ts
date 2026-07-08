const isoDayKeyLength = 'YYYY-MM-DD'.length
const isoMonthKeyLength = 'YYYY-MM'.length

/** UTC calendar day key, for example `2026-07-08`. */
export function utcDayKey(date: Date = new Date()) {
	return date.toISOString().slice(0, isoDayKeyLength)
}

/** UTC calendar month key, for example `2026-07`. */
export function utcMonthKey(date: Date = new Date()) {
	return date.toISOString().slice(0, isoMonthKeyLength)
}

/** Day key of an ISO 8601 UTC timestamp string, for example `2026-07-08`. */
export function isoTimestampDayKey(isoTimestamp: string) {
	return isoTimestamp.slice(0, isoDayKeyLength)
}
