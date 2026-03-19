import { z } from 'zod'
import { createGitHubRestClient } from '#mcp/github/github-rest-client.ts'
import { defineCapability } from '../define-capability.ts'
import { type CapabilityContext } from '../types.ts'

function fullNameFromRepositoryUrl(repositoryUrl: string | undefined) {
	if (!repositoryUrl) return null
	const prefix = 'https://api.github.com/repos/'
	if (repositoryUrl.startsWith(prefix)) {
		return repositoryUrl.slice(prefix.length)
	}
	return null
}

const inputSchema = z.object({
	review_requested_login: z
		.string()
		.min(1)
		.default('kentcdodds')
		.describe('GitHub login to use in review-requested search.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.default(10)
		.describe('Max items to return (1–50).'),
})

const outputSchema = z.object({
	query: z.string(),
	total_count: z.number(),
	items: z.array(
		z.object({
			kind: z.literal('review_requested_pr'),
			title: z.string(),
			html_url: z.string(),
			repository_full_name: z.string().nullable(),
			number: z.number(),
			author_login: z.string().nullable(),
			reason: z.string(),
		}),
	),
})

export const getReviewQueueCapability = defineCapability({
	name: 'get_review_queue',
	domain: 'work-triage',
	description:
		'List open pull requests where a given GitHub user has a pending review request.',
	keywords: ['github', 'review', 'queue', 'pull request', 'pr', 'triage'],
	readOnly: true,
	idempotent: true,
	inputSchema,
	outputSchema,
	async handler(args, ctx: CapabilityContext) {
		const client = createGitHubRestClient(ctx.env)
		const login = args.review_requested_login.trim()
		const query = `is:pr is:open review-requested:${login}`
		const search = await client.searchIssues(query, args.limit)

		const items = search.items
			.filter((item) => item.pull_request !== undefined)
			.map((item) => ({
				kind: 'review_requested_pr' as const,
				title: item.title,
				html_url: item.html_url,
				repository_full_name: fullNameFromRepositoryUrl(item.repository_url),
				number: item.number,
				author_login: item.user?.login ?? null,
				reason: 'You are listed as a requested reviewer on this PR.',
			}))

		return {
			query,
			total_count: search.total_count,
			items,
		}
	},
})
