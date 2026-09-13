import { z } from 'zod'
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
		throw new Error(error.message)
	}
	throw error
}
