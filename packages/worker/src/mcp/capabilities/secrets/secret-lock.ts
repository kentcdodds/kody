import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	createSecretPackageGrantAlreadyPresentMessage,
	createSecretPackageGrantRequiresWebsiteMessage,
} from '#mcp/secrets/errors.ts'
import {
	buildSecretPackageApprovalUrl,
	buildSecretUsageUrl,
} from '#mcp/secrets/package-approval-url.ts'
import { inspectUserSecretPackageGrant } from '#mcp/secrets/service.ts'

const outputSchema = z.object({
	name: z.string(),
	scope: z.literal('user'),
	allowed_packages: z.array(z.string()),
	usage_url: z.string(),
	status: z.enum(['approval_required', 'already_granted']),
	approval_url: z.string(),
	message: z.string(),
})

export const secretLockCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretLock',
		description:
			'Return a website approval URL so the account owner can grant a user-scoped secret to a saved package (one-click Allow, same spirit as /connect/secrets host approval). This capability does not change allowed_packages. Send the approval_url to the user and wait; never treat this call as a grant. Only the owner can add a grant at /account/secrets/approve or the secret editor. Removing a grant is also website-only. User secrets still allow execute and self-authored / adopted packages to read unless the owner tightens further on the account page. secretSet cannot change allowed_packages.',
		keywords: [
			'secret',
			'lock',
			'package',
			'usage',
			'restrict',
			'grant',
			'allowed_packages',
			'approval',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('User-scoped secret name to grant.'),
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that may use this secret.'),
		}),
		outputSchema,
		async handler(
			args: { name: string; package_id: string },
			ctx: CapabilityContext,
		) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const state = await inspectUserSecretPackageGrant({
					env: ctx.env,
					userId: user.userId,
					name: args.name,
					packageId: args.package_id,
				})
				const approvalUrl = buildSecretPackageApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					name: state.secret.name,
					scope: 'user',
					packageId: state.savedPackage.id,
					kodyId: state.savedPackage.kodyId,
					storageContext: null,
				})
				const usageUrl = buildSecretUsageUrl({
					baseUrl: ctx.callerContext.baseUrl,
					name: state.secret.name,
				})
				if (state.alreadyGranted) {
					return {
						name: state.secret.name,
						scope: 'user' as const,
						allowed_packages: state.secret.allowedPackages,
						usage_url: usageUrl,
						status: 'already_granted' as const,
						approval_url: approvalUrl,
						message: createSecretPackageGrantAlreadyPresentMessage({
							packageName: state.savedPackage.kodyId,
						}),
					}
				}
				return {
					name: state.secret.name,
					scope: 'user' as const,
					allowed_packages: state.secret.allowedPackages,
					usage_url: usageUrl,
					status: 'approval_required' as const,
					approval_url: approvalUrl,
					message: createSecretPackageGrantRequiresWebsiteMessage({
						approvalUrl,
					}),
				}
			} catch (error) {
				if (error instanceof McpCallerError) throw error
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to inspect this secret package grant.',
					{ cause: error },
				)
			}
		},
	},
)
