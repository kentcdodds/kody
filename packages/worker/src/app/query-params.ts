/**
 * Parse a positive integer query parameter (for example `?page=2`), falling
 * back when the value is missing or invalid and clamping to `max` when given.
 */
export function readPositiveInt(
	value: string | null,
	fallback: number,
	max?: number,
) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed) || parsed < 1) {
		return fallback
	}
	return max === undefined ? parsed : Math.min(parsed, max)
}
