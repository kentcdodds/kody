import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'
import { fetchMarkdownPreferredDoc } from './fetch-markdown-doc.ts'
import { assertGithubDocsPath } from './github-docs-path.ts'

const GITHUB_DOCS_ORIGIN = 'https://docs.github.com'

const localeGraphqlPrefix = /^\/(?:[a-z]{2}|[a-z]{2}-[a-z]{2})\/graphql(?:\/|$)/

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Path on docs.github.com for GraphQL reference pages, starting with `/{locale}/graphql/` (no host). Example: `/en/graphql/overview`.',
		),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status from docs.github.com.'),
	contentType: z
		.string()
		.nullable()
		.describe('Response Content-Type header, if present.'),
	markdownTokenEstimate: z
		.string()
		.nullable()
		.describe(
			'Optional x-markdown-tokens header when the response is markdown.',
		),
	body: z
		.string()
		.describe(
			'Response body (typically markdown when Content-Type is text/markdown).',
		),
})

function assertGithubGraphqlDocsPath(path: string) {
	assertGithubDocsPath({
		path,
		localePrefix: localeGraphqlPrefix,
		apiLabel: 'GraphQL',
		localePrefixExample: '/en/graphql/',
		examplePath: '/en/graphql/overview',
		docsUrl: 'https://docs.github.com/en/graphql',
	})
}

export const githubGraphqlApiDocsCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'github_graphql_api_docs',
		description:
			'Read-only fetch of GitHub GraphQL API reference documentation from docs.github.com with Accept: text/markdown so responses are markdown when available.',
		keywords: [
			'github',
			'graphql',
			'documentation',
			'docs',
			'markdown',
			'api reference',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			assertGithubGraphqlDocsPath(args.path)
			const url = new URL(args.path.trim(), GITHUB_DOCS_ORIGIN).toString()
			return fetchMarkdownPreferredDoc(url)
		},
	},
)
