export const invalidRedirectUriMessage =
	'Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.'

export const invalidClientIdMismatchMessage =
	'Invalid client. The clientId provided does not match to this client.'

export function canResetStoredClientForMessage(
	message: string | null | undefined,
) {
	return (
		message === invalidRedirectUriMessage ||
		message === invalidClientIdMismatchMessage
	)
}
