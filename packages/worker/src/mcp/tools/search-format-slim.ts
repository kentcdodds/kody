import { getSearchEntityPluginForMatch } from './search-entity-registry.ts'
import {
	type SearchMatch,
	type SlimSearchMatch,
} from './search-format-types.ts'

export function toSlimStructuredMatches(input: {
	matches: Array<SearchMatch>
	baseUrl: string
	username?: string | null
}): Array<SlimSearchMatch> {
	return input.matches.map((match) => {
		const plugin = getSearchEntityPluginForMatch(match)
		if (!plugin?.formatSlimMatch) {
			throw new Error(`No slim formatter registered for ${match.type}.`)
		}
		return plugin.formatSlimMatch({
			match: match as never,
			baseUrl: input.baseUrl,
			username: input.username,
		})
	})
}
