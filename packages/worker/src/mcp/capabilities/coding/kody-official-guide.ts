import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	guideMetadataList,
	importGuideCatalog,
} from '#worker/guide-catalog-modules.ts'

/**
 * Guide markdown is bundled from `docs/guides/` at build time (see
 * `#worker/guides/catalog.ts` for the web-facing catalog), so this
 * capability, search `{id}:guide` entities, the `/guides` web pages, and
 * the raw `text/markdown` responses always serve the same deployed content
 * with no request-time GitHub dependency.
 *
 * Only `guideMetadataList` (frontmatter, no bodies) is statically imported
 * here — registering `coding_guide_get` must not add every guide body's
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
		'Prefer `search({ entity: "{id}:guide" })` to read a guide — do not execute this capability just to load documentation.',
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
})

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z
		.string()
		.describe(
			'Markdown body bundled from the repository guide file (official, versioned with the deployment).',
		),
})

const allKeywords = [
	'coding_guide_get',
	'official guide capability',
	'load guide from execute',
]

export const kodyOfficialGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'coding_guide_get',
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
			return {
				title: guide.title,
				body: guide.body,
			}
		},
	},
)
