/** Connection profile name rules. Names are URL-encoded in `?profile=`. */

export const connectionProfileNameMaxLength = 64

const connectionProfileReservedNames = ['unlimited'] as const

export type ConnectionProfileNameValidationError =
	| 'empty'
	| 'too_long'
	| 'reserved'
	| 'invalid'

export function normalizeConnectionProfileName(value: string) {
	return value.trim()
}

export function getConnectionProfileNameValidationError(
	value: string,
): ConnectionProfileNameValidationError | null {
	const name = normalizeConnectionProfileName(value)
	if (!name) return 'empty'
	if (name.length > connectionProfileNameMaxLength) return 'too_long'
	if (
		connectionProfileReservedNames.includes(
			name.toLowerCase() as (typeof connectionProfileReservedNames)[number],
		)
	) {
		return 'reserved'
	}
	// Reject control characters and raw `?&#=` so URL/query embedding stays sane.
	for (const char of name) {
		const code = char.charCodeAt(0)
		if (code < 0x20 || code === 0x7f || '?#&='.includes(char)) {
			return 'invalid'
		}
	}
	return null
}

export function connectionProfileNameErrorMessage(
	error: ConnectionProfileNameValidationError,
) {
	switch (error) {
		case 'empty':
			return 'Profile name is required.'
		case 'too_long':
			return `Profile name must be at most ${connectionProfileNameMaxLength} characters.`
		case 'reserved':
			return 'Profile name "Unlimited" is reserved for the default connection.'
		case 'invalid':
			return 'Profile name cannot include ?, #, &, =, or control characters.'
		default: {
			const exhaustive: never = error
			throw new Error(`Unexpected profile name error: ${exhaustive}`)
		}
	}
}

/** Build the MCP URL with `?profile=` (URL-component encoded). */
export function buildConnectionProfileMcpUrl(input: {
	mcpServerUrl: string
	profileName: string
}) {
	const url = new URL(input.mcpServerUrl)
	url.searchParams.set(
		'profile',
		normalizeConnectionProfileName(input.profileName),
	)
	return url.toString()
}

export function readConnectionProfileNameFromUrl(
	url: string | URL,
): string | null {
	try {
		const parsed = typeof url === 'string' ? new URL(url) : url
		const value = parsed.searchParams.get('profile')
		if (value === null) return null
		const name = normalizeConnectionProfileName(value)
		return name.length > 0 ? name : null
	} catch {
		return null
	}
}

/**
 * Pull a profile name from an OAuth resource URI that may carry `?profile=`,
 * then return the resource without query or hash (audience stays `/mcp`).
 */
export function stripConnectionProfileFromResourceUri(resource: string): {
	canonicalResource: string
	profileName: string | null
} {
	try {
		const url = new URL(resource)
		const profileName = readConnectionProfileNameFromUrl(url)
		url.search = ''
		url.hash = ''
		return {
			canonicalResource: url.toString(),
			profileName,
		}
	} catch {
		return { canonicalResource: resource, profileName: null }
	}
}
