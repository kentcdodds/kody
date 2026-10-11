import { z } from 'zod'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { inspectCommunityForkAdoption } from '#worker/community/service.ts'
import {
	normalizePackageNameInput,
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { buildCommunityForkAdoptionHref } from '#universal/community-fork-adoption.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
} from '#worker/package-registry/repo.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'

const communityForkAdoptPackageRuntimeErrorMessage =
	'communityForkAdopt is unavailable from package runtime contexts. Call it from an interactive MCP agent after reviewing the fork source.'

function assertDirectMcpCaller(callerContext: {
	executionOrigin?: string
	storageContext?: {
		packageId?: string | null
		appId?: string | null
		storageId?: string | null
	} | null
}) {
	if (callerContext.executionOrigin !== 'interactive') {
		throw new McpCallerError(communityForkAdoptPackageRuntimeErrorMessage)
	}
	const storageContext = callerContext.storageContext
	const packageId = storageContext?.packageId?.trim() ?? ''
	const appId = storageContext?.appId?.trim() ?? ''
	const storageId = storageContext?.storageId?.trim() ?? ''
	if (packageId || appId || storageId) {
		throw new McpCallerError(communityForkAdoptPackageRuntimeErrorMessage)
	}
}

export const communityForkAdoptCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'communityForkAdopt',
		orgPermission: 'package:read',
		description:
			'Return a website adoption URL for a community-forked package. Adoption keeps fork provenance but grants self-authored-like read/use access to your user secrets (mutations still need an allowed_packages grant). This capability never adopts: only the account owner can adopt, signed in on the package settings page, after reviewing the source. Send the approval_url to the user and wait; never treat this call as adoption.',
		keywords: [
			'community',
			'fork',
			'adopt',
			'review',
			'trust',
			'package',
			'secret',
			'approval',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe(packageIdLookupDescription),
			kody_id: z
				.string()
				.min(1)
				.optional()
				.describe(packageNameLookupDescription),
		}),
		outputSchema: z.object({
			status: z.enum(['approval_required', 'already_adopted']),
			package_id: z.string(),
			kody_id: z.string(),
			listing_id: z.string(),
			origin_commit: z.string(),
			adopted_at: z.string().nullable(),
			approval_url: z.string(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			assertDirectMcpCaller(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const packageIdCount =
				(args.package_id !== undefined ? 1 : 0) +
				(args.kody_id !== undefined ? 1 : 0)
			if (packageIdCount !== 1) {
				throw new McpCallerError(
					'Provide exactly one of `package_id` or the package name leaf.',
				)
			}
			let requestedKodyId: string | undefined
			if (args.kody_id !== undefined) {
				try {
					requestedKodyId = normalizePackageNameInput({
						value: args.kody_id,
						ownerScope: owner.ownerScope,
						action: 'resolve',
					})
				} catch (error) {
					throw new McpCallerError(getErrorMessage(error), { cause: error })
				}
			}
			// Authorize before inspect so missing / self-authored / forked
			// packages do not leak distinct errors or kodyIds to teammates who
			// only have Use on another package in the bound org.
			const saved =
				args.package_id !== undefined
					? await getSavedPackageById(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							packageId: args.package_id,
						})
					: await resolveSavedPackageRef(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							match: 'slug',
							ref: requestedKodyId ?? '',
						})
			if (!saved) {
				const missingId = args.package_id ?? args.kody_id
				throw new McpCallerError(`Saved package "${missingId}" was not found.`)
			}
			await authorize(
				{ env: ctx.env, request: ctx.callerContext.request },
				'package:read',
				packageResource(saved),
			)
			const state = await inspectCommunityForkAdoption({
				env: ctx.env,
				userId: owner.ownerUserId,
				packageId: saved.id,
			})
			const approvalUrl = new URL(
				buildCommunityForkAdoptionHref({
					username: state.ownerScope,
					kodyId: state.kodyId,
				}),
				ctx.callerContext.baseUrl,
			).toString()
			return {
				status: state.adoptedAt
					? ('already_adopted' as const)
					: ('approval_required' as const),
				package_id: state.packageId,
				kody_id: state.kodyId,
				listing_id: state.listingId,
				origin_commit: state.originCommit,
				adopted_at: state.adoptedAt,
				approval_url: approvalUrl,
				message: state.adoptedAt
					? `Package "${state.kodyId}" is already adopted.`
					: `Agents cannot adopt community forks. Send the owner to ${approvalUrl} to review the source and adopt "${state.kodyId}" on the website.`,
			}
		},
	},
)
