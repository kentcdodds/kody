import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'

/**
 * Marks failures that originate in user-authored module code (sandbox throws,
 * user build failures, sandbox timeouts). Sentry `beforeSend` drops these via
 * `isUserCodeError` so they never open platform issues — without matching on
 * brittle message text.
 */
export class UserCodeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'UserCodeError'
	}
}

export function isUserCodeError(error: unknown) {
	return getErrorCauseChain(error).some(
		(entry) => entry instanceof UserCodeError,
	)
}
