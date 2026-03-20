import { z } from 'zod'
import { createGitHubGraphqlClient } from '#mcp/github/github-graphql-client.ts'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const inputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe(
			'GraphQL query or mutation string to send to https://api.github.com/graphql.',
		),
	variables: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Optional GraphQL variables object (JSON).'),
	operationName: z
		.string()
		.min(1)
		.optional()
		.describe('Optional GraphQL operation name.'),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status code from GitHub.'),
	data: z
		.unknown()
		.nullable()
		.describe('GraphQL data payload when present.'),
	errors: z
		.array(z.unknown())
		.nullable()
		.describe('GraphQL errors array when present.'),
	extensions: z
		.unknown()
		.nullable()
		.describe('Optional GraphQL extensions payload.'),
})

export const githubGraphqlCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'github_graphql',
		description:
			'Low-level GitHub GraphQL API access. Sends the provided query/mutation with optional variables and returns data/errors from the response.',
		keywords: ['github', 'graphql', 'api', 'query', 'mutation', 'bot'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const client = createGitHubGraphqlClient(ctx.env)
			const response = await client.query({
				query: args.query.trim(),
				variables: args.variables,
				operationName: args.operationName?.trim() || undefined,
			})
			return normalizeGraphqlResponse(response)
		},
	},
)

function normalizeGraphqlResponse(response: {
	status: number
	body: { data?: unknown; errors?: Array<unknown>; extensions?: unknown } | null
}) {
	if (
		!response.body ||
		typeof response.body !== 'object' ||
		Array.isArray(response.body)
	) {
		return { status: response.status, data: null, errors: null, extensions: null }
	}
	const { data, errors, extensions } = response.body
	if (errors != null && !Array.isArray(errors)) {
		throw new Error('GitHub GraphQL response "errors" is not an array.')
	}
	return {
		status: response.status,
		data: data ?? null,
		errors: errors ?? null,
		extensions: extensions ?? null,
	}
}
