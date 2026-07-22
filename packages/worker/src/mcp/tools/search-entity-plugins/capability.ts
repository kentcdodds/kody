import { searchCapabilities } from '#mcp/capabilities/capability-search.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'

import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from '../markdown-safety.ts'
import {
	buildCapabilityExecuteExample,
	buildCapabilityUsage,
	buildEntityRef,
	formatList,
	formatOneLineSentence,
} from '../search-format-helpers.ts'
import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'
import {
	type SearchCandidate,
	type SearchCapabilityMatch,
} from '../search-types.ts'

function getSynthesizedProviderIdentity(spec: CapabilitySpec):
	| {
			key: string
			providerFields: Array<string>
			operationFields: Array<string>
	  }
	| undefined {
	switch (spec.source) {
		case 'builtin':
			return undefined
		case 'remote-connector':
			return spec.remoteConnector
				? {
						key: `remote-connector:${spec.remoteConnector.instanceId}`,
						providerFields: [
							spec.remoteConnector.instanceId,
							spec.remoteConnector.connectorId,
							spec.remoteConnector.connectorName,
						],
						operationFields: [
							spec.remoteConnector.mcpToolName,
							spec.remoteConnector.toolName,
						],
					}
				: undefined
		case 'mcp-server':
			return spec.mcpServer
				? {
						key: `mcp-server:${spec.mcpServer.serverId}`,
						providerFields: [
							spec.mcpServer.serverName,
							spec.mcpServer.kodyName,
						],
						operationFields: [
							spec.mcpServer.mcpToolName,
							spec.mcpServer.toolName,
						],
					}
				: undefined
		case 'openapi':
			return spec.openApi
				? {
						key: `openapi:${spec.openApi.bindingName}`,
						providerFields: [spec.openApi.bindingName, spec.openApi.kodyName],
						operationFields: [spec.openApi.operationSlug],
					}
				: undefined
		default: {
			const exhaustiveSource: never = spec.source
			return exhaustiveSource
		}
	}
}

function capabilityMatchToCandidate(
	match: SearchCapabilityMatch,
	spec: CapabilitySpec,
): SearchCandidate {
	const providerIdentity = getSynthesizedProviderIdentity(spec)
	return {
		match: {
			type: 'capability',
			name: spec.name,
			description: spec.description,
			source: spec.source,
			...(spec.remoteConnector
				? { remoteConnector: spec.remoteConnector }
				: {}),
			...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
			...(spec.openApi ? { openApi: spec.openApi } : {}),
		},
		type: 'capability',
		id: spec.name,
		title: spec.name,
		searchFields: [
			spec.name,
			spec.domain,
			spec.description,
			...(spec.keywords ?? []),
			...(spec.inputFields ?? []),
			...(spec.outputFields ?? []),
		],
		identityFields: [
			spec.name,
			spec.domain,
			...(providerIdentity?.operationFields ?? []),
		],
		...(providerIdentity
			? {
					providerIdentityFields: providerIdentity.providerFields,
					synthesizedProviderKey: providerIdentity.key,
				}
			: {}),
		scoreComponents: buildCandidateBaseScore({
			lexical: match.lexicalScore,
			...(match.vectorRank != null ? { vector: match.vectorScore } : {}),
		}),
	}
}

export const capabilitySearchEntityPlugin = {
	type: 'capability',
	candidateTimingKey: 'capabilityCandidatesMs',
	buildDescriptors(input) {
		return Object.values(input.registry.capabilitySpecs).map((spec) => ({
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
		}))
	},
	async buildCandidates(input) {
		const capabilitySearch = await searchCapabilities({
			env: input.env,
			query: input.query,
			limit: Math.max(1, Object.keys(input.registry.capabilitySpecs).length),
			detail: false,
			specs: input.registry.capabilitySpecs,
			...(input.sharedQueryVector
				? { queryVector: input.sharedQueryVector }
				: {}),
		})

		return capabilitySearch.matches
			.map((match) => {
				const spec = input.registry.capabilitySpecs[match.name]
				if (!spec || spec.name !== match.name) {
					throw new Error(
						`Capability search result "${match.name}" did not map to a registry spec by name.`,
					)
				}
				return capabilityMatchToCandidate(match, spec)
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
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
	},
	formatEntityDetail(detail) {
		const relatedOperations = detail.relatedOperations ?? []
		const lines = [
			`# Capability — \`${detail.spec.name}\``,
			'',
			detail.spec.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'capability')}\``,
			`- Domain: \`${detail.spec.domain}\``,
			`- Source: \`${detail.spec.source}\``,
			`- Required input fields: ${formatList(detail.spec.requiredInputFields)}`,
			`- Read-only: ${detail.spec.readOnly ? 'yes' : 'no'}`,
			`- Idempotent: ${detail.spec.idempotent ? 'yes' : 'no'}`,
			`- Destructive: ${detail.spec.destructive ? 'yes' : 'no'}`,
			'',
			'## Execute from `execute`',
			'',
			'Built-in capabilities returned by `search` are available inside `execute` as methods on the imported `kody` object.',
			'',
			'```ts',
			buildCapabilityExecuteExample(detail.spec),
			'```',
			'',
			'Pass concrete arguments that satisfy the input type below; use `{}` when there are no required fields.',
			'',
			'## Type definitions',
			'',
			'```ts',
			detail.spec.inputTypeDefinition,
			...(detail.spec.outputTypeDefinition
				? ['', detail.spec.outputTypeDefinition]
				: []),
			'```',
		]
		if (relatedOperations.length > 0) {
			lines.push('', '## Related operations (same provider)', '')
			for (const related of relatedOperations) {
				const openApiSuffix =
					related.method && related.path
						? ` — ${formatMarkdownInlineCode(`${related.method.toUpperCase()} ${related.path}`)}`
						: ''
				lines.push(
					`- ${formatMarkdownInlineCode(related.name)}${openApiSuffix} — ${escapeMarkdownText(formatOneLineSentence(related.description))} Entity: ${formatMarkdownInlineCode(related.entityRef)}`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'capability',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'capability'),
				title: detail.title,
				description: detail.description,
				usage: buildCapabilityUsage(detail.spec),
				executeExample: buildCapabilityExecuteExample(detail.spec),
				requiredInputFields: detail.spec.requiredInputFields,
				readOnly: detail.spec.readOnly,
				idempotent: detail.spec.idempotent,
				destructive: detail.spec.destructive,
				source: detail.spec.source,
				...(detail.spec.remoteConnector
					? { remoteConnector: detail.spec.remoteConnector }
					: {}),
				...(detail.spec.mcpServer ? { mcpServer: detail.spec.mcpServer } : {}),
				...(detail.spec.openApi ? { openApi: detail.spec.openApi } : {}),
				inputTypeDefinition: detail.spec.inputTypeDefinition,
				...(detail.spec.outputTypeDefinition
					? { outputTypeDefinition: detail.spec.outputTypeDefinition }
					: {}),
				...(relatedOperations.length > 0 ? { relatedOperations } : {}),
			},
		}
	},
} satisfies SearchEntityPlugin<'capability'>

export async function buildCapabilityCandidates(
	input: Parameters<
		NonNullable<typeof capabilitySearchEntityPlugin.buildCandidates>
	>[0],
) {
	return await capabilitySearchEntityPlugin.buildCandidates(input)
}
