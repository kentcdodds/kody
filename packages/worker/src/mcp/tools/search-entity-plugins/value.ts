import { lexicalScore } from '#mcp/capabilities/capability-search.ts'
import { isPlatformReservedValueName } from '#mcp/values/value-name-guards.ts'
import {
	buildValueEntityId,
	describeValue,
} from '#mcp/tools/search-entities.ts'

import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import {
	buildEntityRef,
	buildValueUsage,
	formatTtlMs,
} from '../search-format-helpers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'

export const valueSearchEntityPlugin = {
	type: 'value',
	buildValueRowDescriptor(row) {
		if (isPlatformReservedValueName(row.name)) return undefined
		return {
			type: 'value',
			id: buildValueEntityId(row),
			title: row.name,
			primaryAliases: [row.name],
			secondaryAliases: [row.description, row.scope],
			tertiaryAliases: [row.value],
		}
	},
	buildCandidates(input) {
		return input.optionalRows.userValueRows
			.flatMap((row) => {
				if (isPlatformReservedValueName(row.name)) return []
				const lexical = lexicalScore(
					input.query,
					[row.name, row.description, row.scope, row.value].join('\n'),
				)
				return [
					{
						match: {
							type: 'value' as const,
							valueId: buildValueEntityId(row),
							name: row.name,
							description: describeValue(row),
							scope: row.scope,
							appId: row.appId,
						},
						type: 'value' as const,
						id: buildValueEntityId(row),
						title: row.name,
						searchFields: [row.name, row.description, row.scope, row.value],
						scoreComponents: buildCandidateBaseScore({
							lexical,
						}),
					},
				]
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
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
	},
	formatEntityDetail(detail) {
		const lines = [
			`# Value — \`${detail.row.name}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'value')}\``,
			`- Scope: \`${detail.row.scope}\``,
			`- App ID: ${detail.row.appId ? `\`${detail.row.appId}\`` : 'none'}`,
			`- Updated at: \`${detail.row.updatedAt}\``,
			`- TTL (ms): ${formatTtlMs(detail.row.ttlMs)}`,
			'',
			'## Read this value',
			'',
			`- \`${buildValueUsage(detail.row.name, detail.row.scope)}\``,
			`- \`kody.value_list({ scope: ${JSON.stringify(detail.row.scope)} })\``,
			'',
			'## Stored value',
			'',
			'```text',
			detail.row.value,
			'```',
		]
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'value',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'value'),
				title: detail.title,
				description: detail.description,
				usage: buildValueUsage(detail.row.name, detail.row.scope),
				scope: detail.row.scope,
				appId: detail.row.appId,
				value: detail.row.value,
				updatedAt: detail.row.updatedAt,
				ttlMs: detail.row.ttlMs,
			},
		}
	},
} satisfies SearchEntityPlugin<'value'>
