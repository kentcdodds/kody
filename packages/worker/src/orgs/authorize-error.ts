/**
 * Thrown when OAuth authorize cannot bind a requested org (`?org=` mismatch,
 * unknown slug, no access). Callers map this to an authorize error response
 * instead of minting an unbound grant.
 */
export class OrgAuthorizeError extends Error {
	readonly code = 'invalid_org' as const

	constructor(message: string) {
		super(message)
		this.name = 'OrgAuthorizeError'
	}
}

export function isOrgAuthorizeError(
	error: unknown,
): error is OrgAuthorizeError {
	return error instanceof OrgAuthorizeError
}
