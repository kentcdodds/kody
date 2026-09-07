import { z } from 'zod'
import { type InviteRecord } from '#worker/invites.ts'
import { parseStoredPlanName } from '#universal/plans.ts'
import { planNameSchema } from './admin-shared.ts'

export const adminInviteCreatedSchema = z.object({
	code: z.string(),
	maxUses: z.number().int().positive(),
	note: z.string(),
	plan: planNameSchema,
	expiresAt: z.string().nullable(),
	createdAt: z.string(),
})

export const adminInviteListedSchema = adminInviteCreatedSchema.extend({
	useCount: z.number().int().nonnegative(),
	revokedAt: z.string().nullable(),
})

export type AdminInviteCreated = z.infer<typeof adminInviteCreatedSchema>

export function toCreatedInviteMetadata(invite: InviteRecord) {
	return {
		code: invite.code,
		maxUses: invite.max_uses,
		note: invite.note,
		plan: parseStoredPlanName(invite.plan),
		expiresAt: invite.expires_at,
		createdAt: invite.created_at,
	}
}

export function toListedInviteMetadata(invite: InviteRecord) {
	return {
		...toCreatedInviteMetadata(invite),
		useCount: invite.use_count,
		revokedAt: invite.revoked_at,
	}
}
