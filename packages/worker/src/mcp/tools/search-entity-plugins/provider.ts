import { type SearchEntityPlugin } from '../search-entity-plugin.ts'

/**
 * Result-only summary for a synthesized MCP/OpenAPI provider. Provider cards
 * keep general discovery bounded while exact operations remain entity-backed.
 */
export const providerSearchEntityPlugin = {
	type: 'provider',
	formatSlimMatch({ match }) {
		return {
			type: 'provider',
			id: match.id,
			title: match.title,
			description: match.description,
			domain: match.domain,
			source: match.source,
			capabilityCount: match.capabilityCount,
			sampleCapabilities: match.sampleCapabilities,
			usage: match.usage,
			wrappingPackage: match.wrappingPackage,
		}
	},
} satisfies SearchEntityPlugin<'provider'>
