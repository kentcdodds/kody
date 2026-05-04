import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
	kody_id: z.string().min(1).optional(),
	allow_force: z.boolean().optional().default(false),
})

const checkSchema = z.object({
	kind: z.enum([
		'manifest',
		'dependencies',
		'bundle',
		'typecheck',
		'lint',
		'smoke',
	]),
	ok: z.boolean(),
	message: z.string(),
})

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('already_published'),
		published_commit: z.string().nullable(),
	}),
	z.object({
		status: z.literal('not_fast_forward'),
		previous_commit: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('checks_failed'),
		failed_checks: z.array(checkSchema),
		manifest: z.unknown(),
		run_id: z.string(),
	}),
	z.object({
		status: z.literal('published'),
		previous_commit: z.string().nullable(),
		published_commit: z.string(),
		manifest: z.unknown(),
		checks: z.array(checkSchema),
	}),
])

export const publishExternalPushCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_publish_external_push',
		description:
			'Publish the current Artifacts git HEAD for a saved package after server-side checks pass.',
		keywords: ['package', 'publish', 'git', 'artifacts', 'external', 'push'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { source } = await resolveOwnedPackageSource({
				db: ctx.env.APP_DB,
				userId: user.userId,
				args: {
					package_id: args.package_id,
					kody_id: args.kody_id,
				},
			})
			const publishedCommit = source.published_commit
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const newCommit = head.commit
			if (!newCommit) {
				throw new Error(
					`Artifacts repo "${source.repo_id}" has no published HEAD to reconcile.`,
				)
			}
			if (newCommit === publishedCommit) {
				return {
					status: 'already_published',
					published_commit: publishedCommit,
				} as const
			}
			const sessionId = `external-publish-${source.id}`
			return repoSessionRpc(ctx.env, sessionId).publishFromExternalRef({
				sessionId,
				sourceId: source.id,
				userId: user.userId,
				newCommit,
				expectedHead: newCommit,
				allowForce: args.allow_force,
				baseUrl: ctx.callerContext.baseUrl,
			})
		},
	},
)
