import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoRunChecksOutputSchema,
	repoSessionIdSchema,
} from './repo-shared.ts'

export const repoRunChecksCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_run_checks',
		description:
			'Run the Worker-native validation pipeline for an active repo session so edits can be checked before publish.',
		keywords: ['repo', 'checks', 'validate', 'typecheck', 'bundle', 'manifest'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoRunChecksOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).runChecks({
				sessionId: args.session_id,
				userId: user.userId,
			})
			return {
				ok: result.ok,
				results: result.results.map((entry) => ({
					kind: entry.kind,
					ok: entry.ok,
					message: entry.message,
				})),
				manifest: result.manifest,
			}
		},
	},
)
