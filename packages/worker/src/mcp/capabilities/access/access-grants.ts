import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	getGrantById,
	isGrantResourceType,
	listGrants,
	softDeleteGrant,
	upsertGrant,
	type GrantSubject,
} from '#worker/orgs/access-writes.ts'
import {
	accessGrantSchema,
	authorizeGrantTarget,
	grantPresetSchema,
	grantResourceTypeSchema,
	readPermissionList,
	requireOrgPermission,
	requirePresetOrPermissions,
	resolveAuthorizedGrantPermissions,
	resolvePersonId,
	resolveTeamId,
	rethrowAccessError,
	toAccessGrantPayload,
} from './shared.ts'

async function resolveGrantSubject(
	db: D1Database,
	orgId: string,
	input: {
		subject_type: 'user' | 'team'
		subject_id?: string
		username?: string
		team_slug?: string
	},
): Promise<GrantSubject> {
	const subjectType = input.subject_type
	switch (subjectType) {
		case 'user':
			if (input.team_slug) {
				throw new McpCallerError('team_slug is only for a team subject.')
			}
			return {
				type: 'user',
				id: await resolvePersonId(db, {
					userId: input.subject_id,
					username: input.username,
				}),
			}
		case 'team':
			if (input.username) {
				throw new McpCallerError('username is only for a user subject.')
			}
			return {
				type: 'team',
				id: await resolveTeamId(db, orgId, {
					teamId: input.subject_id,
					teamSlug: input.team_slug,
				}),
			}
		default: {
			const exhaustive: never = subjectType
			throw new Error(`Unknown grant subject: ${String(exhaustive)}`)
		}
	}
}

export const accessGrantCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessGrant',
		orgPermission: 'none',
		description:
			'Grant a user or team Use, Contribute, or Manage on a resource in the organization this request is bound to, or pass an explicit permission list instead of a preset. Organization grants use resource_type org and this organization id. You need manage access on that resource (or member:write for an organization grant).',
		keywords: ['grant', 'access', 'permission', 'share', 'preset'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			resource_type: grantResourceTypeSchema.describe(
				'package, app, job, secret, integration, memory, email, or org.',
			),
			resource_id: z.string().min(1),
			subject_type: z.enum(['user', 'team']),
			subject_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Person id or team id. Omit when passing username or team_slug.',
				),
			username: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			preset: grantPresetSchema.optional(),
			permissions: z
				.array(z.string().min(1))
				.optional()
				.describe('Advanced grant. Do not combine with preset.'),
		}),
		outputSchema: z.object({ grant: accessGrantSchema }),
		async handler(args, ctx) {
			try {
				const permissions = readPermissionList(args.permissions)
				requirePresetOrPermissions({
					preset: args.preset,
					permissions,
				})
				const scoped = await authorizeGrantTarget(
					ctx,
					args.resource_type,
					args.resource_id,
				)
				const resolved = await resolveAuthorizedGrantPermissions(ctx, {
					resourceType: args.resource_type,
					preset: args.preset,
					permissions,
				})
				const subject = await resolveGrantSubject(
					scoped.db,
					scoped.request.org.id,
					{
						subject_type: args.subject_type,
						subject_id: args.subject_id,
						username: args.username,
						team_slug: args.team_slug,
					},
				)
				const written = await upsertGrant({
					db: scoped.db,
					orgId: scoped.request.org.id,
					resourceType: args.resource_type,
					resourceId: args.resource_id,
					subject,
					preset: args.preset ?? null,
					permissions: args.preset ? null : [...resolved],
					createdByUserId: scoped.user.userId,
				})
				const grant = await getGrantById({
					db: scoped.db,
					orgId: scoped.request.org.id,
					grantId: written.id,
				})
				if (!grant) throw new Error('Grant was not saved.')
				return { grant: toAccessGrantPayload(grant) }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const accessRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessRevoke',
		orgPermission: 'none',
		description:
			'Revoke one live grant in the organization this request is bound to. You need manage access on that grant resource (or member:write for an organization grant).',
		keywords: ['grant', 'revoke', 'access', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({
			grant_id: z.string(),
			revoked: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				requireMcpUser(ctx.callerContext)
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const grant = await getGrantById({
					db,
					orgId: request.org.id,
					grantId: args.grant_id,
				})
				if (!grant || !isGrantResourceType(grant.resourceType)) {
					throw new McpCallerError('Grant was not found in this organization.')
				}
				await authorizeGrantTarget(ctx, grant.resourceType, grant.resourceId)
				await softDeleteGrant({
					db,
					orgId: request.org.id,
					grantId: grant.id,
				})
				return { grant_id: grant.id, revoked: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const accessListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessList',
		orgPermission: 'member:read',
		description:
			'List live grants in the organization this request is bound to. Filter by resource or subject when you already know which one you want.',
		keywords: ['grant', 'list', 'access', 'who has access'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			resource_type: grantResourceTypeSchema.optional(),
			resource_id: z.string().min(1).optional(),
			subject_type: z.enum(['user', 'team']).optional(),
			subject_id: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			grants: z.array(accessGrantSchema),
		}),
		async handler(args, ctx) {
			try {
				const { db, request } = await requireOrgPermission(ctx, 'member:read')
				const grants = await listGrants({
					db,
					orgId: request.org.id,
					resourceType: args.resource_type,
					resourceId: args.resource_id,
					subjectType: args.subject_type,
					subjectId: args.subject_id,
				})
				return { grants: grants.map(toAccessGrantPayload) }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)
