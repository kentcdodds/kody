/**
 * Shared email send-destination contract for account settings, MCP
 * capabilities, and emailSend. Identity email is always listable and is never
 * stored as an additional destination row. Mail still comes from the
 * platform-assigned sender.
 */
export const identityEmailDestinationId = 'identity'

/** Extra addresses besides the account identity email. */
export const maxAdditionalEmailNotificationDestinations = 5

export type EmailNotificationDestination = {
	id: string
	email: string
	kind: 'identity' | 'additional'
	verified: boolean
	isDefault: boolean
	canRemove: boolean
}
