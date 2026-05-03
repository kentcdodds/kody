import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	packagePublishInputSchema,
	packagePublishOutputSchema,
	requirePackageSession,
} from './package-shell-shared.ts'

export const packagePublishCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_publish',
		description:
			'Publish a package shell session after package_check has passed on the current pushed package commit.',
		keywords: ['package', 'publish', 'shell', 'session', 'checks', 'artifact'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: packagePublishInputSchema,
		outputSchema: packagePublishOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session = await requirePackageSession({
				env: ctx.env,
				userId: user.userId,
				sessionId: args.session_id,
			})
			await repoSessionRpc(ctx.env, session.id).syncSessionFromRemote({
				sessionId: session.id,
				userId: user.userId,
			})
			const result = await repoSessionRpc(ctx.env, session.id).publishSession({
				sessionId: session.id,
				userId: user.userId,
			})
			switch (result.status) {
				case 'ok': {
					return {
						status: 'ok' as const,
						session_id: result.sessionId,
						published_commit: result.publishedCommit,
						message: result.message,
					}
				}
				case 'checks_outdated': {
					return {
						status: 'checks_outdated' as const,
						session_id: result.sessionId,
						published_commit: null,
						message: result.message,
					}
				}
				case 'base_moved': {
					return {
						status: 'base_moved' as const,
						session_id: result.sessionId,
						published_commit: null,
						message: result.message,
						repair_hint: result.repairHint,
						session_base_commit: result.sessionBaseCommit,
						current_published_commit: result.currentPublishedCommit,
					}
				}
				default: {
					const exhaustiveCheck: never = result
					return exhaustiveCheck
				}
			}
		},
	},
)
