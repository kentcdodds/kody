import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoSearchInputSchema, repoSearchOutputSchema } from './repo-shared.ts'

export const repoSearchCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_search',
		description:
			'Search within a repo session using rg-style lexical matching over the live session workspace. This is scoped code/file search, not semantic retrieval.',
		keywords: ['repo', 'search', 'ripgrep', 'regex', 'literal', 'files'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoSearchInputSchema,
		outputSchema: repoSearchOutputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const session = repoSessionRpc(ctx.env, args.session_id)
			const result = await session.search({
				sessionId: args.session_id,
				pattern: args.pattern,
				mode: args.mode,
				glob: args.glob,
				path: args.path,
				caseSensitive: args.case_sensitive,
				before: args.before,
				after: args.after,
				limit: args.limit,
				outputMode: args.output_mode,
			})
			return {
				files: result.files,
				total_files: result.totalFiles,
				total_matches: result.totalMatches,
				output_mode: result.outputMode,
				truncated: result.truncated,
			}
		},
	},
)
