import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	EmailDestinationError,
	type EmailNotificationDestination,
} from '#worker/email/destinations.ts'

export const emailDestinationSchema = z.object({
	id: z.string(),
	email: z.string(),
	kind: z.enum(['identity', 'additional']),
	verified: z.boolean(),
	is_default: z.boolean(),
	can_remove: z.boolean(),
})

export function toEmailDestination(destination: EmailNotificationDestination) {
	return {
		id: destination.id,
		email: destination.email,
		kind: destination.kind,
		verified: destination.verified,
		is_default: destination.isDefault,
		can_remove: destination.canRemove,
	}
}

export function mapEmailDestinationError(error: unknown): never {
	if (error instanceof EmailDestinationError) {
		throw new McpCallerError(error.message)
	}
	throw error
}
