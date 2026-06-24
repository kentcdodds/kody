import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { planArtifactRepoInventory } from '#worker/repo/artifact-inventory-planner.ts'

const classificationSchema = z.enum([
	'referenced_source_root',
	'unreferenced_fork',
	'unreferenced_source_like_root',
	'unknown_unreferenced',
])

const inputSchema = z.object({
	namespace: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional Artifacts namespace to inspect. Defaults to the configured ARTIFACTS_NAMESPACE.',
		),
	max_repos: z
		.number()
		.int()
		.min(1)
		.max(10_000)
		.default(1000)
		.describe('Maximum number of Artifacts repos to list for this dry run.'),
	sample_limit: z
		.number()
		.int()
		.min(0)
		.max(500)
		.default(50)
		.describe('Maximum number of per-repo plan entries to return.'),
})

const repoPlanSchema = z.object({
	name: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
	last_push_at: z.string().nullable(),
	source: z.string().nullable(),
	classification: classificationSchema,
	delete_candidate: z.boolean(),
	reason: z.string(),
})

const outputSchema = z.object({
	namespace: z.string(),
	total_listed: z.number().int().min(0),
	total_available: z.number().int().min(0),
	truncated: z.boolean(),
	counts: z.record(classificationSchema, z.number().int().min(0)),
	delete_candidate_count: z.number().int().min(0),
	samples: z.array(repoPlanSchema),
})

export const repoArtifactsInventoryCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_artifacts_inventory',
		description:
			'Read-only dry-run inventory for Cloudflare Artifacts repos in the configured namespace. It compares repo names against current Kody source metadata, classifies likely stale roots/forks, and returns deletion candidates without deleting anything.',
		keywords: [
			'artifacts',
			'inventory',
			'cleanup',
			'dry-run',
			'namespace',
			'repo',
			'orphan',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const plan = await planArtifactRepoInventory({
				env: ctx.env,
				userId: user.userId,
				namespace: args.namespace,
				maxRepos: args.max_repos,
				sampleLimit: args.sample_limit,
			})
			return {
				namespace: plan.namespace,
				total_listed: plan.totalListed,
				total_available: plan.totalAvailable,
				truncated: plan.truncated,
				counts: plan.counts,
				delete_candidate_count: plan.deleteCandidateCount,
				samples: plan.samples.map((repo) => ({
					name: repo.name,
					created_at: repo.createdAt,
					updated_at: repo.updatedAt,
					last_push_at: repo.lastPushAt,
					source: repo.source,
					classification: repo.classification,
					delete_candidate: repo.deleteCandidate,
					reason: repo.reason,
				})),
			}
		},
	},
)
