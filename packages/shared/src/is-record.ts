/**
 * Narrows an unknown value to a plain record: a non-null object that is not an
 * array. Use this instead of redefining local `isRecord` / `isPlainObject`
 * guards or hand-rolling `typeof value === 'object'` checks followed by an
 * `as Record<string, unknown>` cast.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
