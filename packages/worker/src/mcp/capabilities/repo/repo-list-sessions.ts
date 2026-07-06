import { type z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import {
	listRepoSessionsBySource,
	listRepoSessionsByUser,
} from '#worker/repo/repo-sessions.ts'
import { toRepoSessionInfoResult } from '#worker/repo/repo-session-tree.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	repoListSessionsInputSchema,
	repoListSessionsOutputSchema,
	type repoResolvedTargetSchema,
} from './repo-shared.ts'

type RepoResolvedTarget = z.infer<typeof repoResolvedTargetSchema>
type RepoListSessionsOutput = z.infer<typeof repoListSessionsOutputSchema>

function toResolvedSourceTarget(source: EntitySourceRow): RepoResolvedTarget {
	return {
		kind: 'source',
		source_id: source.id,
		entity_kind: source.entity_kind,
		entity_id: source.entity_id,
	}
}

async function resolveListSessionTarget(input: {
	db: D1Database
	userId: string
	source: EntitySourceRow
}): Promise<RepoResolvedTarget> {
	if (input.source.entity_kind === 'package') {
		const savedPackage = await getSavedPackageById(input.db, {
			userId: input.userId,
			packageId: input.source.entity_id,
		})
		if (savedPackage) {
			return {
				kind: 'package',
				source_id: input.source.id,
				package_id: savedPackage.id,
				kody_id: savedPackage.kodyId,
				name: savedPackage.name,
			}
		}
	}
	return toResolvedSourceTarget(input.source)
}

export const repoListSessionsCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_list_sessions',
		description:
			'List repo editing sessions for the signed-in user, defaulting to active sessions so agents can discover sessions to resume, inspect, publish, or discard without already knowing session ids.',
		keywords: [
			'repo',
			'session',
			'sessions',
			'list',
			'active',
			'discover',
			'resume',
			'discard',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoListSessionsInputSchema,
		outputSchema: repoListSessionsOutputSchema,
		async handler(args, ctx): Promise<RepoListSessionsOutput> {
			const user = requireMcpUser(ctx.callerContext)
			const rows = args.source_id
				? await listRepoSessionsBySource(ctx.env.APP_DB, {
						userId: user.userId,
						sourceId: args.source_id,
					})
				: await listRepoSessionsByUser(ctx.env.APP_DB, user.userId)
			const sessions: RepoListSessionsOutput['sessions'] = []
			for (const row of rows) {
				if (
					row.user_id !== user.userId ||
					(args.status !== 'all' && row.status !== args.status)
				) {
					continue
				}
				const source = await getEntitySourceByIdForUser(ctx.env.APP_DB, {
					id: row.source_id,
					userId: user.userId,
				})
				if (!source) continue
				sessions.push({
					...toRepoSessionInfoResult(row, source),
					status: row.status,
					resolved_target: await resolveListSessionTarget({
						db: ctx.env.APP_DB,
						userId: user.userId,
						source,
					}),
				})
				if (sessions.length >= args.limit) break
			}
			return { sessions }
		},
	},
)
