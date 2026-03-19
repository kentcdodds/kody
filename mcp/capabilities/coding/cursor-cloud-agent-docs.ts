import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'
import { fetchMarkdownPreferredDoc } from './fetch-markdown-doc.ts'

const CURSOR_DOCS_ORIGIN = 'https://cursor.com'

const inputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			'Path on cursor.com starting with `/docs/` or `/docs-static/` (no host). Example: `/docs/cloud-agent/api/endpoints`. OpenAPI: `/docs-static/cloud-agents-openapi.yaml`.',
		),
})

const outputSchema = z.object({
	status: z.number().describe('HTTP status from cursor.com.'),
	contentType: z
		.string()
		.nullable()
		.describe('Response Content-Type header, if present.'),
	markdownTokenEstimate: z
		.string()
		.nullable()
		.describe(
			'Optional x-markdown-tokens header (present when the edge returns markdown conversion).',
		),
	body: z
		.string()
		.describe(
			'Response body (markdown or plain text; negotiated with Accept: text/markdown).',
		),
})

function assertCursorCloudDocsPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/docs/cloud-agent/api/endpoints`).',
		)
	}
	if (!trimmed.startsWith('/docs/') && !trimmed.startsWith('/docs-static/')) {
		throw new Error(
			'path must start with `/docs/` or `/docs-static/` on cursor.com.',
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

export const cursorCloudAgentDocsCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'cursor_cloud_agent_docs',
		description:
			'Read-only fetch of Cursor Cloud Agents documentation from cursor.com using Accept negotiation for markdown-oriented responses (https://cursor.com/docs/cloud-agent/api/endpoints and linked pages).',
		keywords: [
			'cursor',
			'cloud agents',
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
			assertCursorCloudDocsPath(args.path)
			const url = new URL(args.path.trim(), CURSOR_DOCS_ORIGIN).toString()
			return fetchMarkdownPreferredDoc(url)
		},
	},
)
