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
	assignee_login: z
		.string()
		.min(1)
		.default('kentcdodds')
		.describe('GitHub login for assigned open issues.'),
	review_requested_login: z
		.string()
		.min(1)
		.default('kentcdodds')
		.describe('GitHub login for review-requested PR search.'),
	limit_per_query: z
		.number()
		.int()
		.min(1)
		.max(25)
		.default(10)
		.describe('Max items per search leg (1–25).'),
	max_items: z
		.number()
		.int()
		.min(1)
		.max(40)
		.default(20)
		.describe('Max combined items after merge (1–40).'),
})

const workItemSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('assigned_issue'),
		title: z.string(),
		html_url: z.string(),
		repository_full_name: z.string().nullable(),
		number: z.number(),
		author_login: z.string().nullable(),
		reason: z.string(),
	}),
	z.object({
		kind: z.literal('review_requested_pr'),
		title: z.string(),
		html_url: z.string(),
		repository_full_name: z.string().nullable(),
		number: z.number(),
		author_login: z.string().nullable(),
		reason: z.string(),
	}),
])

const outputSchema = z.object({
	items: z.array(workItemSchema),
})

export const getNextWorkItemsCapability = defineCapability({
	name: 'get_next_work_items',
	domain: 'work-triage',
	description:
		'Combine open issues assigned to you and open PRs requesting your review into one ranked work list.',
	keywords: [
		'github',
		'issues',
		'pull request',
		'queue',
		'triage',
		'assigned',
		'review',
	],
	readOnly: true,
	idempotent: true,
	inputSchema,
	outputSchema,
	async handler(args, ctx: CapabilityContext) {
		const client = createGitHubRestClient(ctx.env)
		const assignee = args.assignee_login.trim()
		const reviewer = args.review_requested_login.trim()

		const [assignedSearch, reviewSearch] = await Promise.all([
			client.searchIssues(
				`is:open is:issue assignee:${assignee}`,
				args.limit_per_query,
			),
			client.searchIssues(
				`is:pr is:open review-requested:${reviewer}`,
				args.limit_per_query,
			),
		])

		const byUrl = new Map<string, z.infer<typeof workItemSchema>>()

		for (const item of assignedSearch.items) {
			if (item.pull_request) continue
			byUrl.set(item.html_url, {
				kind: 'assigned_issue',
				title: item.title,
				html_url: item.html_url,
				repository_full_name: fullNameFromRepositoryUrl(item.repository_url),
				number: item.number,
				author_login: item.user?.login ?? null,
				reason: `Open issue assigned to ${assignee}.`,
			})
		}

		for (const item of reviewSearch.items) {
			if (!item.pull_request) continue
			if (!byUrl.has(item.html_url)) {
				byUrl.set(item.html_url, {
					kind: 'review_requested_pr',
					title: item.title,
					html_url: item.html_url,
					repository_full_name: fullNameFromRepositoryUrl(item.repository_url),
					number: item.number,
					author_login: item.user?.login ?? null,
					reason: `PR is open and you are a requested reviewer.`,
				})
			}
		}

		const items = [...byUrl.values()].slice(0, args.max_items)

		return { items }
	},
})
