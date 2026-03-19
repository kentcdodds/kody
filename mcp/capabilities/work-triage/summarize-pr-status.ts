import { z } from 'zod'
import { createGitHubRestClient } from '#mcp/github/github-rest-client.ts'
import { defineCapability } from '../define-capability.ts'
import { type CapabilityContext } from '../types.ts'

const inputSchema = z
	.object({
		owner: z
			.string()
			.min(1)
			.describe('Repository owner (org or user). Example: kentcdodds'),
		repo: z.string().min(1).describe('Repository name. Example: kody'),
		pr_number: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('Pull request number when known.'),
		branch: z
			.string()
			.min(1)
			.optional()
			.describe('Head branch name when pr_number is omitted. Example: fix/ci'),
		head_owner: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Owner for head repo when the PR is from a fork (defaults to owner).',
			),
	})
	.refine(
		(value) => value.pr_number !== undefined || Boolean(value.branch?.trim()),
		{
			message: 'Provide pr_number or branch.',
			path: ['pr_number'],
		},
	)

const outputSchema = z.object({
	owner: z.string(),
	repo: z.string(),
	number: z.number(),
	title: z.string(),
	html_url: z.string(),
	state: z.string(),
	draft: z.boolean(),
	head_ref: z.string(),
	base_ref: z.string(),
	head_sha: z.string(),
	mergeable: z.boolean().nullable(),
	mergeable_state: z.string().nullable(),
	combined_status_state: z.string(),
	failing_contexts: z.array(z.string()),
	reviews: z.array(
		z.object({
			state: z.string(),
			login: z.string().nullable(),
		}),
	),
	suggested_next_step: z.string(),
})

async function resolvePullNumber(
	client: ReturnType<typeof createGitHubRestClient>,
	args: z.infer<typeof inputSchema>,
): Promise<number> {
	if (args.pr_number !== undefined) return args.pr_number
	const headOwner = args.head_owner?.trim() || args.owner
	const branch = args.branch?.trim()
	if (!branch) {
		throw new Error('branch is required when pr_number is omitted.')
	}
	const pulls = await client.listOpenPullsForHead(
		args.owner,
		args.repo,
		headOwner,
		branch,
	)
	if (pulls.length === 0) {
		throw new Error(
			`No open pull request found for head ${headOwner}:${branch}.`,
		)
	}
	if (pulls.length > 1) {
		throw new Error(
			`Multiple open pull requests matched head ${headOwner}:${branch}; specify pr_number.`,
		)
	}
	return pulls[0]!.number
}

function buildSuggestedNextStep(input: {
	mergeableState: string | null
	combinedStatusState: string
	failingContexts: Array<string>
	reviewStates: Array<string>
}): string {
	if (input.failingContexts.length > 0) {
		return `Fix failing checks: ${input.failingContexts.join(', ')}.`
	}
	if (input.reviewStates.includes('CHANGES_REQUESTED')) {
		return 'Address requested changes from reviewers, then re-request review.'
	}
	if (input.mergeableState === 'blocked') {
		return 'Resolve merge blockers (branch protection or required reviews).'
	}
	if (
		input.combinedStatusState === 'success' &&
		input.reviewStates.includes('APPROVED')
	) {
		return 'CI is green and there is approval; merge when ready.'
	}
	if (input.combinedStatusState === 'success') {
		return 'CI is green; wait for review or request reviewers.'
	}
	return 'Review CI and review state to decide next action.'
}

export const summarizePrStatusCapability = defineCapability({
	name: 'summarize_pr_status',
	domain: 'work-triage',
	description:
		'Summarize a single GitHub pull request: mergeability, combined CI status, reviews, and a suggested next step. Use pr_number or branch to identify the PR.',
	keywords: [
		'github',
		'pull request',
		'pr',
		'ci',
		'status',
		'review',
		'merge',
		'triage',
	],
	readOnly: true,
	idempotent: true,
	inputSchema,
	outputSchema,
	async handler(args, ctx: CapabilityContext) {
		const client = createGitHubRestClient(ctx.env)
		const number = await resolvePullNumber(client, args)
		const pull = await client.getPullRequest(args.owner, args.repo, number)
		const combined = await client.getCombinedStatus(
			args.owner,
			args.repo,
			pull.head.sha,
		)
		const reviews = await client.listPullReviews(
			args.owner,
			args.repo,
			pull.number,
		)

		const failing = combined.statuses
			.filter((s) => s.state === 'failure' || s.state === 'error')
			.map((s) => s.context)

		const reviewStates = reviews.map((r) => r.state ?? 'UNKNOWN')
		const suggested_next_step = buildSuggestedNextStep({
			mergeableState: pull.mergeable_state,
			combinedStatusState: combined.state,
			failingContexts: failing,
			reviewStates,
		})

		return {
			owner: args.owner,
			repo: args.repo,
			number: pull.number,
			title: pull.title,
			html_url: pull.html_url,
			state: pull.state,
			draft: pull.draft,
			head_ref: pull.head.ref,
			base_ref: pull.base.ref,
			head_sha: pull.head.sha,
			mergeable: pull.mergeable,
			mergeable_state: pull.mergeable_state,
			combined_status_state: combined.state,
			failing_contexts: failing,
			reviews: reviews.map((r) => ({
				state: r.state ?? 'UNKNOWN',
				login: r.user?.login ?? null,
			})),
			suggested_next_step,
		}
	},
})
