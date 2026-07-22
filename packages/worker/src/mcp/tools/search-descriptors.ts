import {
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { buildValueEntityId } from '#mcp/tools/search-entities.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

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

export function flattenReferencedTypeFields(
	referencedTypes:
		| ReadonlyArray<{ name: string; definition: string }>
		| undefined,
): Array<string> {
	return (referencedTypes ?? []).flatMap((referencedType) => [
		referencedType.name,
		referencedType.definition,
	])
}

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

export function buildIntegrationSearchDocument(input: {
	integrationName: string
	description: string
	config: NonNullable<ReturnType<typeof parseIntegrationConfig>>
}): string {
	return [
		input.integrationName,
		input.description,
		input.config.tokenUrl,
		input.config.apiBaseUrl ?? '',
		input.config.flow,
		input.config.authorization?.authorizeUrl ?? '',
		...(input.config.authorization?.scopes ?? []),
		...(input.config.requiredHosts ?? []),
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}

export function buildRecommendedNextStep(
	input: SearchGuidanceContext,
): string | undefined {
	const [topMatch] = input.matches
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
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
}): Array<SearchableEntityDescriptor> {
	const descriptors: Array<SearchableEntityDescriptor> = []

	for (const spec of Object.values(input.registry.capabilitySpecs)) {
		descriptors.push({
			type: 'capability',
			id: spec.name,
			title: spec.name,
			primaryAliases: [spec.name],
			secondaryAliases: [
				spec.domain,
				spec.description,
				...(spec.keywords ?? []),
			],
			tertiaryAliases: [
				...(spec.inputFields ?? []),
				...(spec.outputFields ?? []),
			],
		})
	}

	for (const entry of input.optionalRows.packageRows) {
		const services = Array.isArray(entry.projection.services)
			? entry.projection.services
			: []
		const subscriptions = Array.isArray(entry.projection.subscriptions)
			? entry.projection.subscriptions
			: []
		const retrievers = Array.isArray(entry.projection.retrievers)
			? entry.projection.retrievers
			: []
		descriptors.push({
			type: 'package',
			id: entry.record.kodyId,
			title: entry.record.name,
			primaryAliases: [entry.record.kodyId, entry.record.name],
			secondaryAliases: [
				entry.record.description,
				entry.record.searchText ?? '',
				...entry.record.tags,
			],
			tertiaryAliases: [
				...entry.projection.exports.flatMap((exportDetail) => [
					exportDetail.subpath,
					exportDetail.description ?? '',
					exportDetail.typeDefinition ?? '',
					...flattenReferencedTypeFields(exportDetail.referencedTypes),
					...(exportDetail.functions ?? []).flatMap((fn) => [
						fn.name,
						fn.description ?? '',
						fn.typeDefinition ?? '',
						...flattenReferencedTypeFields(fn.referencedTypes),
					]),
				]),
				...entry.projection.jobs.map((job) => job.name),
				...services.flatMap((service) => [
					service.name,
					service.entry,
					service.mode,
					service.autoStart ? 'auto-start' : 'manual-start',
				]),
				...subscriptions.flatMap((subscription) => [
					subscription.topic,
					subscription.handler,
					subscription.description ?? '',
				]),
				...retrievers.flatMap((retriever) => [
					retriever.key,
					retriever.name,
					retriever.description,
				]),
				entry.readmeSnippet?.snippet ?? '',
				...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
			],
		})
	}

	for (const row of input.optionalRows.userValueRows) {
		const integrationName = parseIntegrationValueName(row.name)
		if (integrationName) {
			const config = parseIntegrationConfig(
				parseIntegrationJson(row.value),
				integrationName,
			)
			if (!config) continue
			descriptors.push({
				type: 'integration',
				id: integrationName,
				title: integrationName,
				primaryAliases: [integrationName],
				secondaryAliases: [
					row.description,
					config.apiBaseUrl ?? '',
					config.tokenUrl,
					config.flow,
				],
				tertiaryAliases: [
					...(config.requiredHosts ?? []),
					...(config.apiBaseUrl ? extractSearchTokens(config.apiBaseUrl) : []),
				],
			})
			continue
		}

		descriptors.push({
			type: 'value',
			id: buildValueEntityId(row),
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description, row.scope],
			tertiaryAliases: [row.value],
		})
	}

	for (const row of input.optionalRows.userSecretRows) {
		descriptors.push({
			type: 'secret',
			id: row.name,
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description],
		})
	}

	return descriptors
}
