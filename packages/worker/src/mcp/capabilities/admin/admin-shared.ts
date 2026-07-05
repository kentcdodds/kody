import { z } from 'zod'
import { logAuditEvent } from '#app/audit-log.ts'
import { roleNames } from '#app/permissions.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

export const adminCapabilityAccess = {
	requiredRole: 'admin',
	readOnly: true,
	idempotent: true,
	destructive: false,
} as const

export const roleNameSchema = z.enum(roleNames)

export const adminUserMetadataSchema = z.object({
	id: z.number().int().positive(),
	username: z.string(),
	email: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
	roles: z.array(roleNameSchema),
})

function getErrorReason(error: unknown) {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.slice(0, 240)
	}
	return 'unknown_error'
}

export async function auditAdminCapabilityInvocation<TResult>(
	ctx: CapabilityContext,
	capabilityName: string,
	run: () => Promise<TResult>,
): Promise<TResult> {
	const actorEmail = ctx.callerContext.user?.email
	try {
		const result = await run()
		await logAuditEvent({
			db: ctx.env.APP_DB,
			category: 'admin',
			action: capabilityName,
			result: 'success',
			email: actorEmail,
			path: '/mcp',
			reason: 'mcp_admin_capability',
		})
		return result
	} catch (error) {
		await logAuditEvent({
			db: ctx.env.APP_DB,
			category: 'admin',
			action: capabilityName,
			result: 'failure',
			email: actorEmail,
			path: '/mcp',
			reason: getErrorReason(error),
		})
		throw error
	}
}
