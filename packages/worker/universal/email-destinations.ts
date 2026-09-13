/**
 * Shared notify-self destination contract for account settings, MCP
 * capabilities, and emailSend. Identity email is always listable and is never
 * stored as an additional destination row.
 */
export const identityEmailDestinationId = 'identity'

/** Extra addresses besides the account identity email. */
export const maxAdditionalEmailNotificationDestinations = 5

export type EmailNotificationDestinationKind = 'identity' | 'additional'

export type EmailNotificationDestination = {
	id: string
	email: string
	kind: EmailNotificationDestinationKind
	verified: boolean
	isDefault: boolean
	canRemove: boolean
}
