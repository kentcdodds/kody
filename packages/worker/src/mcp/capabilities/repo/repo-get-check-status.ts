import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { type RepoCheckKind } from '#worker/repo/checks.ts'
import {
	repoCheckStatusOutputSchema,
	repoSessionIdSchema,
} from './repo-shared.ts'

export const repoGetCheckStatusCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_get_check_status',
		description:
			'Inspect the most recent Worker-native check run metadata for an active repo session.',
		keywords: ['repo', 'checks', 'status', 'validate', 'session'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoCheckStatusOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const status = await repoSessionRpc(
				ctx.env,
				args.session_id,
			).getCheckStatus({
				sessionId: args.session_id,
				userId: user.userId,
			})
			return {
				run_id: status.runId,
				tree_hash: status.treeHash,
				checked_at: status.checkedAt,
				ok: status.ok ?? false,
				results: (status.results ?? []).map((entry) => ({
					kind: entry.kind as RepoCheckKind,
					ok: entry.ok,
					message: entry.message,
				})),
			}
		},
	},
)
