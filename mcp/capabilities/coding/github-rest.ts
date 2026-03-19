import { z } from 'zod'
import { createGitHubRestClient } from '#mcp/github/github-rest-client.ts'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const inputSchema = z.object({
	method: httpMethodSchema.describe(
		'HTTP method the GitHub endpoint expects (GET for reads; POST, PUT, PATCH, or DELETE when the REST docs call for them).',
	),
	path: z
		.string()
		.min(1)
		.describe(
			'GitHub REST path starting with / (for example /repos/octocat/Hello-World). Do not include a scheme or host.',
		),
	query: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'Optional query string parameters. All values are sent as strings.',
		),
	body: z
		.unknown()
		.optional()
		.describe('Optional JSON body for POST, PUT, PATCH, or DELETE requests.'),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status code from GitHub.'),
	body: z
		.unknown()
		.nullable()
		.describe('Parsed JSON response body, or null for empty/204 responses.'),
})

function assertSafeGithubPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/repos/...`, not a full URL).',
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

export const githubRestCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'github_rest',
		description:
			'Low-level GitHub REST v3 access: method, path, optional query, optional JSON body. Authenticated as the configured token (GitHub user @kody-bot). Any HTTP method the GitHub REST API defines for a path is supported.',
		keywords: ['github', 'rest', 'api', 'raw', 'low-level', 'fetch', 'bot'],
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
	},
)
