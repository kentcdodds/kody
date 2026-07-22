import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

import {
	buildCapabilityUsage,
	buildEntityRef,
	buildIntegrationUsage,
	buildPackageActionImportUsage,
	buildPackageHostedUrl,
	buildPackageRootImportUsage,
	buildSecretUsage,
	buildValueUsage,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
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
		if (match.type === 'capability') {
			return {
				type: 'capability',
				id: match.name,
				entityRef: buildEntityRef(match.name, 'capability'),
				title: match.name,
				description:
					'description' in match && typeof match.description === 'string'
						? match.description
						: '',
				usage: buildCapabilityUsage(match),
				...(match.source ? { source: match.source } : {}),
				...(match.remoteConnector
					? { remoteConnector: match.remoteConnector }
					: {}),
				...(match.mcpServer ? { mcpServer: match.mcpServer } : {}),
				...(match.openApi ? { openApi: match.openApi } : {}),
				...(match.inputTypeDefinition
					? { inputTypeDefinition: match.inputTypeDefinition }
					: {}),
				...(match.inputTypeDefinitionTruncated
					? { inputTypeDefinitionTruncated: true }
					: {}),
			}
		}
		if (match.type === 'package') {
			const rootImportUsage = buildPackageRootImportUsage(match.name)
			const actionMatches = (match.actionMatches ?? []).map((actionMatch) => {
				const importSpecifier = buildPackageImportSpecifier(
					match.name,
					actionMatch.subpath,
				)
				return {
					subpath: actionMatch.subpath,
					importSpecifier,
					description: actionMatch.description,
					typeDefinition: actionMatch.typeDefinition,
					functions: actionMatch.functions.map((fn) => ({
						name: fn.name,
						description: fn.description,
						typeDefinition: fn.typeDefinition,
						usage: buildPackageActionImportUsage({
							packageName: match.name,
							subpath: actionMatch.subpath,
							functionName: fn.name,
						}),
					})),
					score: actionMatch.score,
					matchedTerms: actionMatch.matchedTerms,
				}
			})
			const [primaryAction] = actionMatches
			const primaryActionFunction = primaryAction
				? getPrimaryPackageActionFunction(primaryAction)
				: null
			const nextStep =
				primaryAction && primaryActionFunction
					? `Use ${primaryActionFunction.usage}; inspect search({ entity: "${match.kodyId}:package" }) only if you need more exports.`
					: match.hasApp
						? `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, jobs, and the hosted app URL.`
						: `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, then import the needed entry from "${buildPackageImportSpecifier(match.name, '.')}".`
			return {
				type: 'package',
				id: match.kodyId,
				entityRef: buildEntityRef(match.kodyId, 'package'),
				packageId: match.packageId,
				kodyId: match.kodyId,
				title: match.title,
				description: match.description,
				usage: primaryActionFunction?.usage ?? rootImportUsage,
				rootImportUsage,
				tags: match.tags,
				hasApp: match.hasApp,
				hidden: match.hidden,
				hostedUrl:
					match.hasApp && input.username
						? buildPackageHostedUrl(input.baseUrl, input.username, match.kodyId)
						: null,
				readmeSnippet: match.readmeSnippet
					? {
							path: match.readmeSnippet.path,
							snippet: match.readmeSnippet.snippet,
							truncated: match.readmeSnippet.truncated,
						}
					: null,
				actionMatches,
				nextStep,
			}
		}
		if (match.type === 'value') {
			return {
				type: 'value',
				id: match.valueId,
				entityRef: buildEntityRef(match.valueId, 'value'),
				name: match.name,
				title: match.name,
				description: match.description,
				usage: buildValueUsage(match.name, match.scope),
				scope: match.scope,
				appId: match.appId,
			}
		}
		if (match.type === 'integration') {
			return {
				type: 'integration',
				id: match.integrationName,
				entityRef: buildEntityRef(match.integrationName, 'integration'),
				name: match.integrationName,
				title: match.title,
				description: match.description,
				usage: buildIntegrationUsage(match.integrationName),
				flow: match.flow,
				tokenUrl: match.tokenUrl,
				apiBaseUrl: match.apiBaseUrl,
				requiredHosts: match.requiredHosts,
				clientIdValueName: match.clientIdValueName,
				clientSecretSecretName: match.clientSecretSecretName,
				accessTokenSecretName: match.accessTokenSecretName,
				refreshTokenSecretName: match.refreshTokenSecretName,
				authorization: match.authorization ?? null,
				nextStep: `Inspect integration detail with search({ entity: "${match.integrationName}:integration" }) and then run a minimal authenticated execute smoke test before building or calling integration-backed code.`,
			}
		}
		if (match.type === 'retriever_result') {
			return {
				type: 'retriever_result',
				id: match.id,
				title: match.title,
				summary: match.summary,
				details: match.details ?? null,
				source: match.source ?? `${match.kodyId}/${match.retrieverKey}`,
				url: match.url ?? null,
				score: match.score ?? null,
				packageId: match.packageId,
				kodyId: match.kodyId,
				retrieverKey: match.retrieverKey,
				retrieverName: match.retrieverName,
			}
		}
		return {
			type: 'secret',
			id: match.name,
			entityRef: buildEntityRef(match.name, 'secret'),
			title: match.name,
			description: match.description,
			usage: buildSecretUsage(match.name),
		}
	})
}
