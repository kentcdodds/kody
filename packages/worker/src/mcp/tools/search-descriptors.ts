import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

import { searchEntityPlugins } from './search-entity-registry.ts'
import {
	type SearchMatch,
	buildKodyCapabilityAccessor,
	buildPackageActionImportUsage,
	getPrimaryPackageActionFunction,
} from './search-format.ts'
import {
	type OptionalSearchRowsResult,
	type SearchGuidanceContext,
} from './search-types.ts'
import {
	type SearchableEntityDescriptor,
	extractSearchTokens,
} from './understand-search-query.ts'

export { buildIntegrationSearchDocument } from './search-entity-plugins/integration.ts'
export { flattenReferencedTypeFields } from './search-entity-plugins/package.ts'

function buildPackageRelationTokens(
	match: Extract<SearchMatch, { type: 'package' }>,
) {
	return new Set(
		extractSearchTokens(
			[match.kodyId, match.name, match.description, match.tags.join(' ')].join(
				'\n',
			),
		),
	)
}

export function buildRecommendedNextStep(
	input: SearchGuidanceContext,
): string | undefined {
	const [topMatch] = input.matches
	if (topMatch?.type === 'domain') {
		return `Broad query answered with a domain overview. Rerun with a task query scoped to one domain, e.g. \`search({ query: "<task>", domain: "${topMatch.name}" })\`, or list a full domain with \`search({ domain: "${topMatch.name}" })\`.`
	}
	const topPackage = input.matches.find((match) => match.type === 'package')
	const topIntegration = input.matches.find(
		(match) => match.type === 'integration',
	)
	const packageRelationTokens = topPackage
		? buildPackageRelationTokens(topPackage)
		: null
	const integrationMatchesPackage =
		topPackage &&
		topIntegration &&
		(packageRelationTokens?.has(topIntegration.integrationName.toLowerCase()) ??
			false)

	if (integrationMatchesPackage && input.intent.task.name === 'operate') {
		return `Found saved package \`${topPackage.kodyId}\` and integration \`${topIntegration.integrationName}\`. Inspect the package with \`search({ entity: "${topPackage.kodyId}:package" })\`, then use the integration detail or an authenticated \`execute\` smoke test to confirm the integration path before running API-backed actions.`
	}
	if (topMatch?.type === 'package') {
		const [actionMatch] = topMatch.actionMatches ?? []
		const actionFunction = actionMatch
			? getPrimaryPackageActionFunction(actionMatch)
			: null
		if (actionMatch && actionFunction) {
			const importStatement = buildPackageActionImportUsage({
				packageName: topMatch.name,
				subpath: actionMatch.subpath,
				functionName: actionFunction.name,
			})
			return `Use \`${importStatement}\` for the matched package action. Inspect \`search({ entity: "${topMatch.kodyId}:package" })\` only if you need more exports or full package detail.`
		}
		return topMatch.hasApp
			? `Inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports, jobs, and the hosted app URL.`
			: `Inspect package detail with \`search({ entity: "${topMatch.kodyId}:package" })\` to review exports, then import the right entry from \`${buildPackageImportSpecifier(topMatch.name, '.')}\` or a subpath export.`
	}
	if (topMatch?.type === 'integration') {
		return `Inspect integration detail with \`search({ entity: "${topMatch.integrationName}:integration" })\` and then run a minimal authenticated \`execute\` smoke test before building or calling integration-backed code.`
	}
	if (topMatch?.type === 'capability') {
		const accessor = buildKodyCapabilityAccessor(topMatch)
		if (
			topMatch.inputTypeDefinition &&
			!topMatch.inputTypeDefinitionTruncated
		) {
			return `Call \`${accessor}(args)\` from \`execute\` using the inlined call shape above. Use \`search({ entity: "${topMatch.name}:capability" })\` only if you need the full type definitions.`
		}
		return `Inspect capability detail with \`search({ entity: "${topMatch.name}:capability" })\` to confirm the TypeScript call shape, then call it from \`execute\` via \`${accessor}(args)\`.`
	}
	return undefined
}

export function buildSearchableEntityDescriptors(input: {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows' | 'userIntegrationRows'
	>
}): Array<SearchableEntityDescriptor> {
	const descriptors: Array<SearchableEntityDescriptor> = []
	const valueRowDescriptorPlugins = searchEntityPlugins.filter(
		(plugin) => 'buildValueRowDescriptor' in plugin,
	)
	for (const plugin of searchEntityPlugins) {
		if ('buildValueRowDescriptor' in plugin) {
			if (plugin !== valueRowDescriptorPlugins[0]) continue
			for (const row of input.optionalRows.userValueRows) {
				for (const valueRowPlugin of valueRowDescriptorPlugins) {
					const descriptor = valueRowPlugin.buildValueRowDescriptor(row)
					if (descriptor) descriptors.push(descriptor)
				}
			}
			continue
		}
		if ('buildDescriptors' in plugin) {
			descriptors.push(...plugin.buildDescriptors(input))
		}
	}
	return descriptors
}
