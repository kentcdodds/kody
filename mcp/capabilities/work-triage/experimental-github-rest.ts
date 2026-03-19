/**
 * ⚠️ EXPERIMENTAL — This capability may change or be removed at any time without
 * notice. Prefer higher-level work-triage capabilities when they fit your use case.
 * Feedback on shape, safety bounds, and ergonomics is welcome.
 */
import { z } from 'zod'
import { createGitHubRestClient } from '#mcp/github/github-rest-client.ts'
import { defineCapability } from '../define-capability.ts'
import { type CapabilityContext } from '../types.ts'

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const inputSchema = z
	.object({
		method: httpMethodSchema.describe(
			'HTTP method. Prefer GET for read-only triage. POST/PUT/PATCH/DELETE can mutate GitHub state.',
		),
		path: z
			.string()
			.min(1)
			.describe(
				'GitHub REST path starting with / (e.g. /repos/octocat/Hello-World). No scheme or host.',
			),
		query: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				'Optional query string parameters (values coerced to strings).',
			),
		body: z
			.unknown()
			.optional()
			.describe('Optional JSON body for POST, PUT, or PATCH.'),
	})
	.describe(
		'EXPERIMENTAL: Low-level GitHub REST call. May change anytime. Feedback welcome. For POST, PUT, PATCH, or DELETE, confirm path, method, and body with the user before executing unless they already approved this exact change.',
	)

const outputSchema = z.object({
	status: z.number().describe('HTTP status code from GitHub.'),
	body: z
		.unknown()
		.nullable()
		.describe('Parsed JSON body, or null for empty/204.'),
})

function assertSafeGithubPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (e.g. use `/repos/...`, not a full URL).',
		)
	}
	if (trimmed.includes('..')) {
		throw new Error('path must not contain `..` segments.')
	}
	if (/[\s#]/.test(trimmed)) {
		throw new Error('path contains disallowed characters.')
	}
	if (trimmed.length > 2048) {
		throw new Error('path exceeds maximum length.')
	}
}

export const experimentalGithubRestCapability = defineCapability({
	name: 'experimental_github_rest',
	domain: 'work-triage',
	description: `EXPERIMENTAL — Low-level GitHub REST v3 access (path + method + optional query/body). May change or be removed anytime; feedback welcome. Prefer summarize_pr_status, get_review_queue, or get_next_work_items when they match your task. Can mutate or delete GitHub data (non-GET methods); confirm with the user before any destructive or write operation unless they explicitly requested that exact change.`,
	keywords: [
		'experimental',
		'github',
		'rest',
		'api',
		'raw',
		'low-level',
		'fetch',
	],
	readOnly: false,
	idempotent: false,
	destructive: true,
	inputSchema,
	outputSchema,
	async handler(args, ctx: CapabilityContext) {
		assertSafeGithubPath(args.path)
		const client = createGitHubRestClient(ctx.env)
		return client.rawRequest({
			method: args.method,
			path: args.path.trim(),
			query: args.query,
			body: args.body,
		})
	},
})
