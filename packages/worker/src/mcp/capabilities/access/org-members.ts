import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { createOrg, updateOrgMemberRole } from '#worker/orgs/access-writes.ts'
import { onMemberSoftRemoved } from '#worker/orgs/member-offboarding.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import {
	orgRoleSchema,
	requireLiveOrg,
	requireOrgPermission,
	resolvePersonId,
	rethrowAccessError,
} from './shared.ts'

function seatRole(role: string) {
	return role === 'owner' || role === 'member'
}

async function liveMembership(db: D1Database, orgId: string, userId: string) {
	return await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ role: string }>()
}

async function liveOwnerCount(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export const orgCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgCreate',
		orgPermission: 'org:write',
		description:
			'Create an organization you own. The id is new and separate from your personal organization. Calls that change the new organization need a request bound to it.',
		keywords: ['org', 'organization', 'create', 'team'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			slug: z
				.string()
				.min(1)
				.describe('Public handle for the organization. Lowercased.'),
			display_name: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				display_name: z.string(),
			}),
		}),
		async handler(args, ctx) {
			try {
				const { user, db } = await requireOrgPermission(ctx, 'org:write')
				const slug = normalizeUsername(args.slug)
				const formatError = getUsernameFormatValidationError(slug)
				if (formatError) throw new McpCallerError(formatError)
				const created = await createOrg({
					db,
					slug,
					displayName: args.display_name,
					createdByUserId: user.userId,
				})
				const org = await requireLiveOrg(db, created.id)
				return {
					org: {
						id: org.id,
						slug: org.slug,
						display_name: org.display_name ?? org.slug,
					},
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const orgMemberUpdateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgMemberUpdate',
		orgPermission: 'member:write',
		description:
			'Change the role of a live member of the organization this request is bound to. Only an Owner can grant or change the Owner role. The last Owner cannot be demoted.',
		keywords: ['member', 'role', 'owner', 'billing'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
			role: orgRoleSchema,
		}),
		outputSchema: z.object({
			user_id: z.string(),
			role: orgRoleSchema,
		}),
		async handler(args, ctx) {
			try {
				const { request, db } = await requireOrgPermission(ctx, 'member:write')
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				const membership = await liveMembership(db, request.org.id, userId)
				if (!membership) {
					throw new McpCallerError(
						'That person is not a member of this organization.',
					)
				}
				if (membership.role === 'owner' || args.role === 'owner') {
					const access = await computeEffectivePermissions({
						env: ctx.env,
						request,
					})
					if (!access.isOwner) {
						throw new McpCallerError('Only an Owner can change the Owner role.')
					}
				}
				const demotingOwner =
					membership.role === 'owner' && args.role !== 'owner'
				if (demotingOwner) {
					const owners = await liveOwnerCount(db, request.org.id)
					if (owners <= 1) {
						throw new McpCallerError('The last Owner cannot be demoted.')
					}
				}
				if (args.role === 'owner' && membership.role !== 'owner') {
					await assertCanAcceptFreeOrgOwnership({
						db,
						orgId: request.org.id,
						userId,
					})
				}
				await updateOrgMemberRole({
					db,
					orgId: request.org.id,
					userId,
					role: args.role,
					protectLastOwner: demotingOwner,
				})
				if (seatRole(membership.role) !== seatRole(args.role)) {
					await syncSeatsAfterMembershipChange({
						db,
						env: ctx.env,
						orgId: request.org.id,
					})
				}
				return { user_id: userId, role: args.role }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const orgMemberRemoveCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgMemberRemove',
		orgPermission: 'member:delete',
		description:
			'Remove a member from the organization this request is bound to. Revokes org-bound credentials, disconnects integrations they connected, and keeps their jobs running, the same as when they leave. Their team memberships in this organization end too. The last Owner cannot be removed.',
		keywords: ['member', 'remove', 'kick'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			user_id: z.string(),
			removed: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				const { db, request } = await requireOrgPermission(ctx, 'member:delete')
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				const membership = await liveMembership(db, request.org.id, userId)
				if (!membership) {
					throw new McpCallerError(
						'That person is not a member of this organization.',
					)
				}
				const removingOwner = membership.role === 'owner'
				if (removingOwner) {
					const access = await computeEffectivePermissions({
						env: ctx.env,
						request,
					})
					if (!access.isOwner) {
						throw new McpCallerError('Only an Owner can remove an Owner.')
					}
					const owners = await liveOwnerCount(db, request.org.id)
					if (owners <= 1) {
						throw new McpCallerError('The last Owner cannot be removed.')
					}
				}
				await onMemberSoftRemoved({
					env: ctx.env,
					orgId: request.org.id,
					userId,
					deletedAt: new Date().toISOString(),
				})
				if (seatRole(membership.role)) {
					await syncSeatsAfterMembershipChange({
						db,
						env: ctx.env,
						orgId: request.org.id,
					})
				}
				return { user_id: userId, removed: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)
