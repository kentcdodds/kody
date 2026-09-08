import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { maxChars } from '#mcp/tools/search-constants.ts'
import { resolveMarkdownDocument } from '#worker/guides/document-sections.ts'
import {
	guideMetadataList,
	importGuideCatalog,
} from '#worker/guide-catalog-modules.ts'

/**
 * Guide markdown is bundled from `docs/guides/` at build time (see
 * `#worker/guides/catalog.ts` for the web-facing catalog), so this
 * capability, search `{id}:guide` entities, the `/docs` web pages, and
 * the raw `text/markdown` responses always serve the same deployed content
 * with no request-time GitHub dependency.
 *
 * Only `guideMetadataList` (frontmatter, no bodies) is statically imported
 * here — registering `codingGuideGet` must not add every guide body's
 * parse/link cost to every platform/runtime Worker isolate's main-module
 * cold start. The full catalog is loaded lazily by `importGuideCatalog()`
 * inside the handler; see `#worker/guide-catalog-modules.ts`.
 */

const advertisedGuides = guideMetadataList.filter(
	(guide) => !guide.unadvertised,
)
const knownGuideIds = new Set(guideMetadataList.map((guide) => guide.id))

function buildCapabilityDescription(): string {
	return [
		'Load an official Kody guide from execute-module code (markdown, bundled from the kody repository).',
		'Prefer `search({ entity: "{id}:guide" })` to read a guide — do not execute this capability just to load documentation. Oversized guides return a table of contents; pass `section` or use `{id}:guide#{slug}` on search.',
		'This capability stays available for execute-module code that needs the markdown body programmatically.',
		'The `guide` input lists each available id. Discover guides with `search({ query: "… guide" })`.',
	].join('\n')
}

const guideFieldSchema = z
	.string()
	.refine((id) => knownGuideIds.has(id), {
		message: 'Unknown Kody guide.',
	})
	.describe(
		[
			'Which guide to load.',
			...advertisedGuides.map((guide) => `\`${guide.id}\`: ${guide.summary}`),
		].join(' '),
	)

const inputSchema = z.object({
	guide: guideFieldSchema,
	section: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional heading title or slug. Oversized guides return a table of contents until a section is requested.',
		),
})

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z
		.string()
		.describe(
			'Markdown body, a heading section, or a table of contents when the bundled guide exceeds the search response budget.',
		),
	bodyMode: z
		.enum(['full', 'toc', 'section'])
		.describe(
			'Whether body is the full guide, a contents index, or one requested heading.',
		),
	section: z
		.object({
			title: z.string(),
			slug: z.string(),
		})
		.nullable()
		.describe('The resolved heading when bodyMode is section.'),
	sections: z
		.array(
			z.object({
				title: z.string(),
				slug: z.string(),
				level: z.number().int(),
			}),
		)
		.describe(
			'Headings that can be requested with section or {id}:guide#{slug}.',
		),
})

const allKeywords = [
	'codingGuideGet',
	'official guide capability',
	'load guide from execute',
]

export const kodyOfficialGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'codingGuideGet',
		description: buildCapabilityDescription(),
		keywords: [...allKeywords],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, _ctx: CapabilityContext) {
			const { guides } = await importGuideCatalog()
			const guide = guides.find((candidate) => candidate.id === args.guide)
			if (!guide) {
				throw new Error(`Unknown Kody guide "${args.guide}".`)
			}
			const resolved = resolveMarkdownDocument({
				markdown: guide.body,
				maxChars,
				entityRef: `${guide.id}:guide`,
				...(args.section ? { section: args.section } : {}),
			})
			return {
				title: guide.title,
				body: resolved.markdown,
				bodyMode: resolved.mode,
				section: resolved.selected
					? {
							title: resolved.selected.title,
							slug: resolved.selected.slug,
						}
					: null,
				sections: resolved.headings
					.filter((heading) => heading.level >= 2)
					.map((heading) => ({
						title: heading.title,
						slug: heading.slug,
						level: heading.level,
					})),
			}
		},
	},
)
