import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'
import { fetchMarkdownPreferredDoc } from './fetch-markdown-doc.ts'

const CLOUDFLARE_DOCS_ORIGIN = 'https://developers.cloudflare.com'

const allowedDocsPrefixes = [
	'/api/',
	'/fundamentals/',
	'/workers/',
	'/workers-ai/',
	'/ai-gateway/',
	'/d1/',
	'/r2/',
	'/kv/',
	'/durable-objects/',
	'/queues/',
	'/vectorize/',
	'/pages/',
] as const

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Path on developers.cloudflare.com for Cloudflare API or product docs, starting with `/api/`, `/fundamentals/`, or another Cloudflare product docs prefix (no host). Example: `/api/resources/accounts/`.',
		),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status from developers.cloudflare.com.'),
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
			'Response body (markdown, plain text, or HTML converted by the docs edge when available).',
		),
})

function assertCloudflareDocsPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/api/resources/accounts/`).',
		)
	}
	if (!allowedDocsPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
		throw new Error(
			`path must start with one of: ${allowedDocsPrefixes.join(', ')} on developers.cloudflare.com.`,
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

export const cloudflareApiDocsCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'cloudflare_api_docs',
		description:
			'Read-only fetch of Cloudflare developer documentation from developers.cloudflare.com using markdown-preferred Accept negotiation for API reference and product docs.',
		keywords: [
			'cloudflare',
			'documentation',
			'docs',
			'api reference',
			'markdown',
			'workers',
			'd1',
			'r2',
			'dns',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			assertCloudflareDocsPath(args.path)
			const url = new URL(args.path.trim(), CLOUDFLARE_DOCS_ORIGIN).toString()
			return fetchMarkdownPreferredDoc(url)
		},
	},
)
