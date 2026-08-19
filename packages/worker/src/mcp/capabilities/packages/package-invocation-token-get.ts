import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getPackageInvocationTokenById } from '#worker/package-invocations/repo.ts'
import {
	packageInvocationTokenMetadataSchema,
	toPackageInvocationTokenMetadata,
} from './shared.ts'

export const packageInvocationTokenGetCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_invocation_token_get',
		description:
			'Get metadata for one package invocation token record owned by the signed-in user, including the owning package, export/source scopes, timestamps, last-used, and revocation status. Raw bearer token values and stored token hashes are never returned.',
		keywords: [
			'package invocation token',
			'invocation token',
			'bearer token',
			'external package invocation',
			'metadata',
			'get',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			token_id: z
				.string()
				.min(1)
				.describe('Package invocation token record id to inspect.'),
		}),
		outputSchema: z.object({
			token: packageInvocationTokenMetadataSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const token = await getPackageInvocationTokenById({
				db: ctx.env.APP_DB,
				userId: user.userId,
				tokenId: args.token_id,
			})
			if (!token) {
				throw new McpCallerError(
					'Package invocation token not found for this user.',
				)
			}
			return {
				token: toPackageInvocationTokenMetadata(token),
			}
		},
	},
)
