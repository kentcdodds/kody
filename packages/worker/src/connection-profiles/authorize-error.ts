/**
 * Thrown when OAuth authorize cannot bind a requested connection profile
 * (unknown name, conflicting inputs). Callers map this to an authorize error
 * response instead of minting an unlimited grant.
 */
export class ConnectionProfileAuthorizeError extends Error {
	readonly code = 'invalid_connection_profile' as const

	constructor(message: string) {
		super(message)
		this.name = 'ConnectionProfileAuthorizeError'
	}
}

export function isConnectionProfileAuthorizeError(
	error: unknown,
): error is ConnectionProfileAuthorizeError {
	return error instanceof ConnectionProfileAuthorizeError
}
