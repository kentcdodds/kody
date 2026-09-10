import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { listPackageInvocationTokensByPackageId } from '#worker/package-invocations/repo.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	packageInvocationTokenMetadataSchema,
	toPackageInvocationTokenMetadata,
} from './shared.ts'

async function resolveSavedPackageByName(
	env: Env,
	user: McpUserContext,
	packageName: string,
) {
	const owner = await resolvePackageOwnerContext(env, user)
	let kodyId: string
	try {
		kodyId = normalizePackageNameInput({
			value: packageName,
			ownerScope: owner.ownerScope,
			action: 'resolve',
		})
	} catch (error) {
		throw new McpCallerError(getErrorMessage(error), { cause: error })
	}
	return await getSavedPackageByKodyId(env.APP_DB, {
		userId: owner.ownerUserId,
		kodyId,
	})
}

export const packageInvocationTokenListCapability = defineDomainCapability(
	capabilityDomainNames.invocationTokens,
	{
		name: 'packageInvocationTokenList',
		description:
			'Unadvertised leftover-token drain. List invocation token metadata for one saved package owned by the signed-in user, including export scopes, timestamps, last-used, and revocation status. Raw bearer token values and stored token hashes are never returned.',
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
				.describe(
					'Saved-package UUID, or package name (`@owner/leaf` or the name leaf). Prefer the scoped name when you know it.',
				),
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
				})) ?? (await resolveSavedPackageByName(ctx.env, user, args.package_id))
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
