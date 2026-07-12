/** Allow only same-origin absolute paths as post-auth redirect targets. */
export function normalizeRedirectTo(value: string | null | undefined) {
	if (!value) return null
	if (!value.startsWith('/')) return null
	if (value.startsWith('//')) return null
	return value
}
