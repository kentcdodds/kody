import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'
import { fetchMarkdownPreferredDoc } from './fetch-markdown-doc.ts'
import { assertGithubDocsPath } from './github-docs-path.ts'

const GITHUB_DOCS_ORIGIN = 'https://docs.github.com'

const localeRestPrefix = /^\/(?:[a-z]{2}|[a-z]{2}-[a-z]{2})\/rest(?:\/|$)/

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Path on docs.github.com for REST reference pages, starting with `/{locale}/rest/` (no host). Example: `/en/rest/repos/repos`.',
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

function assertGithubRestDocsPath(path: string) {
	assertGithubDocsPath({
		path,
		localePrefix: localeRestPrefix,
		apiLabel: 'REST',
		localePrefixExample: '/en/rest/',
		examplePath: '/en/rest/repos/repos',
		docsUrl: 'https://docs.github.com/en/rest',
	})
}

export const githubRestApiDocsCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'github_rest_api_docs',
		description:
			'Read-only fetch of GitHub REST API reference documentation from docs.github.com with Accept: text/markdown so responses are markdown when available.',
		keywords: [
			'github',
			'rest',
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
			assertGithubRestDocsPath(args.path)
			const url = new URL(args.path.trim(), GITHUB_DOCS_ORIGIN).toString()
			return fetchMarkdownPreferredDoc(url)
		},
	},
)
