import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { updateOrgProfile } from '#worker/orgs/org-profile.ts'

export const orgUpdateCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgUpdate',
		orgPermission: 'org:write',
		description:
			'Update the display name and handle of the organization this request is bound to. Signup organizations keep the person’s account profile as their identity.',
		keywords: ['org', 'organization', 'rename', 'slug', 'handle', 'profile'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			display_name: z.string().min(1).max(80).optional(),
			slug: z
				.string()
				.min(1)
				.describe('Public handle for the organization. Lowercased.')
				.optional(),
		}),
		outputSchema: z.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				display_name: z.string().nullable(),
			}),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			if (args.display_name === undefined && args.slug === undefined) {
				throw new McpCallerError('Pass display_name or slug.')
			}
			const updated = await updateOrgProfile(ctx.env.APP_DB, ctx.env, {
				orgId: request.org.id,
				displayName: args.display_name,
				slug: args.slug,
			})
			if (!updated.ok) {
				throw new McpCallerError(updated.error)
			}
			return {
				org: {
					id: request.org.id,
					slug: updated.slug,
					display_name: updated.displayName,
				},
			}
		},
	},
)
