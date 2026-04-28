import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

const capabilitySummarySchema = z.object({
	name: z.string(),
	domain: z.string(),
	description: z.string(),
	keywords: z.array(z.string()),
	readOnly: z.boolean(),
	idempotent: z.boolean(),
	destructive: z.boolean(),
	requiredInputFields: z.array(z.string()),
})

const capabilityDetailSchema = capabilitySummarySchema.extend({
	inputSchema: z.unknown(),
	outputSchema: z.unknown().optional(),
	inputTypeDefinition: z.string(),
	outputTypeDefinition: z.string().optional(),
	inputFields: z.array(z.string()),
	outputFields: z.array(z.string()),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	capabilities: z.array(
		z.union([capabilityDetailSchema, capabilitySummarySchema]),
	),
})

type CapabilitySummary = z.infer<typeof capabilitySummarySchema>
type CapabilityDetail = z.infer<typeof capabilityDetailSchema>
type ListedCapability = CapabilitySummary | CapabilityDetail

function compareCapabilities(
	a: { domain: string; name: string },
	b: { domain: string; name: string },
) {
	return (
		a.domain.localeCompare(b.domain, 'en') || a.name.localeCompare(b.name, 'en')
	)
}

function applyDomainFilter(
	capabilities: Array<ListedCapability>,
	domain: string | undefined,
) {
	if (!domain) return capabilities
	return capabilities.filter((capability) => capability.domain === domain)
}

export const metaListCapabilitiesCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_list_capabilities',
		description:
			'List the current runtime capability registry, including dynamic capabilities such as connected home tools. Use this when search seems incomplete and you need the exact capability names and schemas available right now.',
		keywords: [
			'capabilities',
			'list',
			'registry',
			'discover',
			'search fallback',
			'dynamic',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			domain: z
				.enum([
					capabilityDomainNames.apps,
					capabilityDomainNames.coding,
					capabilityDomainNames.home,
					capabilityDomainNames.jobs,
					capabilityDomainNames.math,
					capabilityDomainNames.meta,
				])
				.optional()
				.describe(
					'Optional domain filter when you only need one capability domain.',
				),
			detail: z
				.boolean()
				.optional()
				.describe(
					'Include schemas and full field lists when true. Defaults to false.',
				),
		}),
		outputSchema,
		async handler(
			args: { domain?: string; detail?: boolean },
			ctx: CapabilityContext,
		) {
			const { getCapabilityRegistryForContext } =
				await import('#mcp/capabilities/registry.ts')
			const registry = await getCapabilityRegistryForContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
			const allCapabilities = Object.values(registry.capabilitySpecs)
				.map((spec) =>
					args.detail
						? {
								name: spec.name,
								domain: spec.domain,
								description: spec.description,
								keywords: spec.keywords,
								readOnly: spec.readOnly,
								idempotent: spec.idempotent,
								destructive: spec.destructive,
								requiredInputFields: spec.requiredInputFields,
								inputSchema: spec.inputSchema,
								...(spec.outputSchema
									? { outputSchema: spec.outputSchema }
									: {}),
								inputTypeDefinition: spec.inputTypeDefinition,
								...(spec.outputTypeDefinition
									? { outputTypeDefinition: spec.outputTypeDefinition }
									: {}),
								inputFields: spec.inputFields,
								outputFields: spec.outputFields,
							}
						: {
								name: spec.name,
								domain: spec.domain,
								description: spec.description,
								keywords: spec.keywords,
								readOnly: spec.readOnly,
								idempotent: spec.idempotent,
								destructive: spec.destructive,
								requiredInputFields: spec.requiredInputFields,
							},
				)
				.sort(compareCapabilities)
			const filteredCapabilities = applyDomainFilter(
				allCapabilities,
				args.domain,
			)
			return {
				total: filteredCapabilities.length,
				capabilities: filteredCapabilities,
			}
		},
	},
)
