import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { backfillRepoSources } from '#worker/repo/source-backfill.ts'

const entityResultSchema = z.object({
	kind: z.enum(['app', 'skill', 'job']),
	id: z.string(),
	title: z.string(),
	status: z.enum(['planned', 'migrated', 'skipped', 'error']),
	reason: z.string().nullable(),
	sourceId: z.string().nullable(),
	publishedCommit: z.string().nullable(),
})

const groupResultSchema = z.object({
	total: z.number().int().nonnegative(),
	planned: z.number().int().nonnegative(),
	migrated: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
	results: z.array(entityResultSchema),
})

export const repoBackfillSourcesCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_backfill_sources',
		description:
			'Backfill legacy inline saved apps, skills, and jobs into repo-backed sources for the signed-in user. Safe to re-run: already-published repo sources are skipped instead of overwritten.',
		keywords: [
			'repo',
			'backfill',
			'migration',
			'source',
			'apps',
			'skills',
			'jobs',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			dry_run: z
				.boolean()
				.optional()
				.describe(
					'Preview the migration plan without mutating D1 rows, syncing artifact repos, or reindexing search. Defaults to true.',
				),
			include_apps: z
				.boolean()
				.optional()
				.describe('Whether to include saved apps in the backfill. Defaults to true.'),
			include_skills: z
				.boolean()
				.optional()
				.describe('Whether to include saved skills in the backfill. Defaults to true.'),
			include_jobs: z
				.boolean()
				.optional()
				.describe('Whether to include saved jobs in the backfill. Defaults to true.'),
			reindex: z
				.boolean()
				.optional()
				.describe(
					'Whether to rebuild search/vector projections after a real backfill. Ignored during dry_run. Defaults to true.',
				),
			sync_app_runners: z
				.boolean()
				.optional()
				.describe(
					'Whether to refresh saved app runners from the newly published repo-backed source after app backfill. Ignored during dry_run. Defaults to true.',
				),
		}),
		outputSchema: z.object({
			dryRun: z.boolean(),
			apps: groupResultSchema,
			skills: groupResultSchema,
			jobs: groupResultSchema,
			reindex: z
				.object({
					apps: z.number().int().nonnegative(),
					skills: z.number().int().nonnegative(),
					jobs: z.number().int().nonnegative(),
				})
				.nullable(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = ctx.callerContext.user
			if (!user) {
				throw new Error('repo_backfill_sources requires an authenticated user.')
			}
			return await backfillRepoSources({
				env: ctx.env,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				dryRun: args.dry_run,
				includeApps: args.include_apps,
				includeSkills: args.include_skills,
				includeJobs: args.include_jobs,
				reindex: args.reindex,
				syncAppRunners: args.sync_app_runners,
			})
		},
	},
)
