import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'
import { fetchNegotiatedThenMaybeBrowserRender } from './fetch-page-markdown.ts'

const gotoWaitUntilSchema = z.enum([
	'load',
	'domcontentloaded',
	'networkidle0',
	'networkidle2',
])

const inputSchema = z
	.object({
		url: z
			.string()
			.optional()
			.describe(
				'Page URL to read as markdown. Prefer your existing web-reading tools first (for example normal fetch with `Accept: text/markdown`, browser tools, or host-specific docs capabilities) and use this only as a fallback when they return unhelpful HTML or cannot load the page.',
			),
		html: z
			.string()
			.optional()
			.describe(
				'Optional raw HTML to convert to markdown. Use this only when you already have HTML and cheaper tools cannot give you markdown directly.',
			),
		userAgent: z
			.string()
			.optional()
			.describe('Optional Browser Rendering user agent override.'),
		rejectRequestPattern: z
			.array(z.string())
			.optional()
			.describe(
				'Optional Browser Rendering request-block regex patterns, for example to skip CSS.',
			),
		gotoOptions: z
			.object({
				waitUntil: gotoWaitUntilSchema
					.optional()
					.describe(
						'Optional Browser Rendering waitUntil strategy for JS-heavy pages.',
					),
			})
			.optional()
			.describe(
				'Optional Browser Rendering navigation controls. Only used when the billed fallback runs.',
			),
	})
	.refine((value) => Boolean(value.url) !== Boolean(value.html), {
		message: 'Provide exactly one of `url` or `html`.',
		path: ['url'],
	})

const outputSchema = z.object({
	source: z
		.enum(['negotiated', 'browser_rendering'])
		.describe(
			'Whether the result came from the cheap markdown-preferred fetch or the billed Browser Rendering fallback.',
		),
	markdown: z.string().describe('Final markdown or plain-text result.'),
	url: z
		.string()
		.nullable()
		.describe('Final normalized URL, or null when converting inline HTML.'),
	negotiated: z
		.object({
			status: z.number(),
			contentType: z.string().nullable(),
			markdownTokenEstimate: z.string().nullable(),
		})
		.nullable()
		.describe(
			'Negotiated fetch metadata. Present when a URL was fetched before deciding whether fallback was needed.',
		),
	browserRendering: z
		.object({
			apiStatus: z.number(),
			mode: z.enum(['url', 'html']),
		})
		.nullable()
		.describe(
			'Browser Rendering metadata. Present only when the billed fallback was used.',
		),
})

export const pageToMarkdownCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'page_to_markdown',
		description:
			'Generic page-to-markdown helper. Try cheaper web-reading mechanisms first (normal fetch with `Accept: text/markdown`, browser/IDE tools, or host-specific docs capabilities like `github_rest_api_docs`) and use this only as a fallback when they return useless HTML or cannot load a page. This capability first does a normal markdown-preferred fetch; only if that still yields HTML does it call billed Cloudflare Browser Rendering `/markdown`.',
		keywords: [
			'markdown',
			'html to markdown',
			'web page',
			'browser rendering',
			'fallback',
			'generic',
			'content extraction',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return fetchNegotiatedThenMaybeBrowserRender(ctx.env, args)
		},
	},
)
