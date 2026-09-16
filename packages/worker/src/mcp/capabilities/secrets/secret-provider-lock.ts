import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	buildSecretProviderPackageApprovalUrl,
	buildSecretProviderUsageUrl,
} from '#mcp/secrets/secret-providers/approval-url.ts'
import {
	createSecretProviderGrantAlreadyPresentMessage,
	createSecretProviderGrantRequiresWebsiteMessage,
} from '#mcp/secrets/secret-providers/errors.ts'
import { secretProvidersFlagKey } from '#mcp/secrets/secret-providers/flag.ts'
import { inspectSecretProviderPackageGrant } from '#mcp/secrets/secret-providers/service.ts'

const outputSchema = z.object({
	provider: z.string(),
	canonical_ref: z.string(),
	package_id: z.string(),
	usage_url: z.string(),
	status: z.enum(['approval_required', 'already_granted']),
	approval_url: z.string(),
	message: z.string(),
})

export const secretProviderLockCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderLock',
		featureFlag: secretProvidersFlagKey,
		description:
			'Return a website approval URL so the account owner can grant a saved package use of one external secret-provider ref (canonical i/<item-uuid>/<field>). This capability does not change grants. Send the approval_url to the user and wait. Ad hoc execute does not need this grant; saved packages do.',
		keywords: [
			'secret',
			'provider',
			'1password',
			'lock',
			'package',
			'grant',
			'approval',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			provider: z
				.string()
				.min(1)
				.describe('Provider id, for example 1password.'),
			ref: z
				.string()
				.min(1)
				.describe(
					'Canonical i/<item-uuid>/<field> ref, or an op:// synonym that already contains the item UUID.',
				),
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that may use this provider ref.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const state = await inspectSecretProviderPackageGrant({
					env: ctx.env,
					userId: user.userId,
					providerId: args.provider,
					ref: args.ref,
					packageId: args.package_id,
				})
				const approvalUrl = buildSecretProviderPackageApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					providerId: state.providerId,
					canonicalRef: state.canonicalRef,
					packageId: state.savedPackage.id,
					kodyId: state.savedPackage.kodyId,
				})
				const usageUrl = buildSecretProviderUsageUrl({
					baseUrl: ctx.callerContext.baseUrl,
				})
				if (state.alreadyGranted) {
					return {
						provider: state.providerId,
						canonical_ref: state.canonicalRef,
						package_id: state.savedPackage.id,
						usage_url: usageUrl,
						status: 'already_granted' as const,
						approval_url: approvalUrl,
						message: createSecretProviderGrantAlreadyPresentMessage({
							packageName: state.savedPackage.kodyId,
						}),
					}
				}
				return {
					provider: state.providerId,
					canonical_ref: state.canonicalRef,
					package_id: state.savedPackage.id,
					usage_url: usageUrl,
					status: 'approval_required' as const,
					approval_url: approvalUrl,
					message: createSecretProviderGrantRequiresWebsiteMessage({
						approvalUrl,
					}),
				}
			} catch (error) {
				if (error instanceof McpCallerError) throw error
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to inspect this secret provider grant.',
					{ cause: error },
				)
			}
		},
	},
)
