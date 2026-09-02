import { z } from 'zod'
import { stableUserIdSchema } from './admin-shared.ts'

export const reservedUsernameListSchema = z.array(z.string())

export const reservedUsernameConflictSchema = z.object({
	username: z.string(),
	stableUserId: stableUserIdSchema,
})

export const reservedUsernamesSnapshotSchema = z.object({
	builtIn: reservedUsernameListSchema,
	added: reservedUsernameListSchema,
	removed: reservedUsernameListSchema,
	conflicts: z.array(reservedUsernameConflictSchema),
	updatedAt: z.string().nullable(),
	updatedBy: z.string().nullable(),
})

export const reservedUsernamesInputSchema = z.object({
	usernames: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			'DNS-safe usernames to add or remove from the runtime reserved list.',
		),
})
