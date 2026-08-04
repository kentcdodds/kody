import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listUserRepos } from '#worker/repo/user-repos.ts'

export const repoListCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_list',
		description:
			'List plain repos owned by the signed-in user from D1 discovery metadata (no live Artifacts reads).',
		keywords: ['repo', 'list', 'plain', 'discovery'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			repos: z.array(
				z.object({
					repo_id: z.string(),
					name: z.string(),
					description: z.string().nullable(),
					created_at: z.string(),
					updated_at: z.string(),
				}),
			),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const repos = await listUserRepos(ctx.env.APP_DB, user.userId)
			return {
				repos: repos.map((repo) => ({
					repo_id: repo.id,
					name: repo.name,
					description: repo.description,
					created_at: repo.createdAt,
					updated_at: repo.updatedAt,
				})),
			}
		},
	},
)
