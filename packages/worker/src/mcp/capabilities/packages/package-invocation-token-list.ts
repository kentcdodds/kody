import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { listPackageInvocationTokensByPackageId } from '#worker/package-invocations/repo.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	packageInvocationTokenMetadataSchema,
	toPackageInvocationTokenMetadata,
} from './shared.ts'

export const packageInvocationTokenListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_invocation_token_list',
		description:
			'List invocation token metadata for one saved package owned by the signed-in user, including export/source scopes, timestamps, last-used, and revocation status. Raw bearer token values and stored token hashes are never returned.',
		keywords: [
			'package invocation token',
			'invocation token',
			'bearer token',
			'external package invocation',
			'metadata',
			'list',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id or kody.id whose tokens to list.'),
		}),
		outputSchema: z.object({
			tokens: z.array(packageInvocationTokenMetadataSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const savedPackage =
				(await getSavedPackageById(ctx.env.APP_DB, {
					userId: user.userId,
					packageId: args.package_id,
				})) ??
				(await getSavedPackageByKodyId(ctx.env.APP_DB, {
					userId: user.userId,
					kodyId: args.package_id,
				}))
			if (!savedPackage) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			const tokens = await listPackageInvocationTokensByPackageId({
				db: ctx.env.APP_DB,
				userId: user.userId,
				packageId: savedPackage.id,
			})
			return {
				tokens: tokens.map(toPackageInvocationTokenMetadata),
			}
		},
	},
)
