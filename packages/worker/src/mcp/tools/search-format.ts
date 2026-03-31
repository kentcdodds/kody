import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { compressSchemaForLlm } from '#mcp/capabilities/schema-compression.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SkillSearchHit, type UnifiedSearchMatch } from '#mcp/capabilities/unified-search.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { parseSkillParameters } from '#mcp/skills/skill-parameters.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

export type SearchEntityType = 'capability' | 'skill' | 'app' | 'secret'

export type SearchResultStructuredContent = {
	matches: Array<SlimSearchMatch>
	offline: boolean
	warnings: Array<string>
	homeConnectorStatus?: {
		connectorId: string
		state: string
		connected: boolean
		toolCount: number
	}
}

export type SlimSearchMatch =
	| {
			type: 'capability'
			id: string
			title: string
			description: string
			usage: string
		}
	| {
			type: 'skill'
			id: string
			title: string
			description: string
			usage: string
			collection: string | null
			collectionSlug: string | null
		}
	| {
			type: 'app'
			id: string
			title: string
			description: string
			usage: string
			hostedUrl: string
		}
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			usage: string
		}

export type SearchEntityDetailStructured =
	| {
			kind: 'entity'
			type: 'capability'
			id: string
			title: string
			description: string
			usage: string
			requiredInputFields: Array<string>
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
			inputSchema: unknown
			outputSchema?: unknown
		}
	| {
			kind: 'entity'
			type: 'skill'
			id: string
			title: string
			description: string
			usage: string
			collection: string | null
			collectionSlug: string | null
			parameters: ReturnType<typeof parseSkillParameters>
			inferredCapabilities: Array<string>
			usesCapabilities: Array<string> | null
			searchText: string | null
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
		}
	| {
			kind: 'entity'
			type: 'app'
			id: string
			title: string
			description: string
			usage: string
			hostedUrl: string
			runtime: string
			parameters: ReturnType<typeof parseUiArtifactParameters>
			hidden: boolean
		}
	| {
			kind: 'entity'
			type: 'secret'
			id: string
			title: string
			description: string
			usage: string
			scope: string
			updatedAt: string
		}

export type SearchEntityDetail =
	| {
			type: 'capability'
			id: string
			title: string
			description: string
			spec: CapabilitySpec
		}
	| {
			type: 'skill'
			id: string
			title: string
			description: string
			row: McpSkillRow
		}
	| {
			type: 'app'
			id: string
			title: string
			description: string
			row: UiArtifactRow
			hostedUrl: string
		}
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			row: SecretSearchRow
		}

export function parseEntityRef(entity: string): {
	id: string
	type: SearchEntityType
} {
	const trimmed = entity.trim()
	const separator = trimmed.lastIndexOf(':')
	if (separator <= 0 || separator === trimmed.length - 1) {
		throw new Error(
			'Entity must use the format "{id}:{type}" where type is capability, skill, app, or secret.',
		)
	}
	const id = trimmed.slice(0, separator).trim()
	const type = trimmed.slice(separator + 1).trim()
	if (
		type !== 'capability' &&
		type !== 'skill' &&
		type !== 'app' &&
		type !== 'secret'
	) {
		throw new Error(
			'Entity type must be one of: capability, skill, app, or secret.',
		)
	}
	if (!id) {
		throw new Error('Entity id must not be empty.')
	}
	return { id, type }
}

export function formatSearchMarkdown(input: {
	matches: Array<UnifiedSearchMatch>
	warnings: Array<string>
	baseUrl: string
}) {
	const lines: Array<string> = ['# Search results', '']
	lines.push(
		'For full detail on one hit, call `search` with `entity: "{id}:{type}"` (example: `cloudflare_api_docs:capability`).',
		'',
		'**How to run matches:**',
		'',
		'- Builtin capabilities — `execute` / `codemode.<name>(args)`',
		'- Saved skills — `codemode.meta_run_skill({ skill_id, params })`',
		'- Saved apps — `open_generated_ui({ app_id })`; users can also open the hosted URL for the saved app',
		'- Secrets — placeholders in execute-time fetches or `codemode.secret_list` (never paste raw secrets in chat)',
	)

	if (input.warnings.length > 0) {
		lines.push('', '## Warnings', '')
		for (const warning of input.warnings) {
			lines.push(`- ${warning}`)
		}
	}

	for (const match of input.matches) {
		lines.push('', ...formatMatchBlock(match, input.baseUrl))
	}

	if (input.matches.every((match) => match.type !== 'secret')) {
		lines.push(
			'',
			'> **Note:** This page does not include any matching user secret references. If you need credential metadata, use `codemode.secret_list` inside `execute` or save secrets via generated UI.',
		)
	}

	return lines.join('\n').trim()
}

function formatMatchBlock(match: UnifiedSearchMatch, baseUrl: string) {
	if (match.type === 'capability') {
		return [
			`## Capability — \`${match.name}\``,
			'',
			match.description,
		]
	}
	if (match.type === 'skill') {
		return [`## Skill — ${match.title}`, '', match.description]
	}
	if (match.type === 'app') {
		const hostedUrl = buildSavedUiUrl(baseUrl, match.appId)
		return [
			`## App — ${match.title}`,
			'',
			match.description,
			'',
			`**Hosted URL:** \`${hostedUrl}\``,
		]
	}
	return [
		`## Secret — \`${match.name}\``,
		'',
		match.description,
	]
}

export function toSlimStructuredMatches(input: {
	matches: Array<UnifiedSearchMatch>
	baseUrl: string
}): Array<SlimSearchMatch> {
	return input.matches.map((match) => {
		if (match.type === 'capability') {
			return {
				type: 'capability',
				id: match.name,
				title: match.name,
				description:
					'description' in match && typeof match.description === 'string'
						? match.description
						: '',
				usage: `execute with codemode.${match.name}(args)`,
			}
		}
		if (match.type === 'skill') {
			return {
				type: 'skill',
				id: match.skillId,
				title: match.title,
				description: match.description,
				usage: `codemode.meta_run_skill({ skill_id: "${match.skillId}", params: { ... } })`,
				collection: match.collection,
				collectionSlug: match.collectionSlug,
			}
		}
		if (match.type === 'app') {
			return {
				type: 'app',
				id: match.appId,
				title: match.title,
				description: match.description,
				usage: `open_generated_ui({ app_id: "${match.appId}" })`,
				hostedUrl: buildSavedUiUrl(input.baseUrl, match.appId),
			}
		}
		return {
			type: 'secret',
			id: match.name,
			title: match.name,
			description: match.description,
			usage: `{{secret:${match.name}|scope=user}}`,
		}
	})
}

function parseJsonStringArray(raw: string | null): Array<string> | null {
	if (raw == null) return null
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return null
		return value.filter((item): item is string => typeof item === 'string')
	} catch {
		return null
	}
}

export function formatEntityDetailMarkdown(detail: SearchEntityDetail) {
	if (detail.type === 'capability') {
		const inputSchema = compressSchemaForLlm(detail.spec.inputSchema)
		const outputSchema =
			detail.spec.outputSchema == null
				? undefined
				: compressSchemaForLlm(detail.spec.outputSchema, {
						stripRootObjectType: false,
					})
		const lines = [
			`# Capability — \`${detail.spec.name}\``,
			'',
			detail.spec.description,
			'',
			'## Summary',
			'',
			`- Domain: \`${detail.spec.domain}\``,
			`- Required input fields: ${formatList(detail.spec.requiredInputFields)}`,
			`- Read-only: ${detail.spec.readOnly ? 'yes' : 'no'}`,
			`- Idempotent: ${detail.spec.idempotent ? 'yes' : 'no'}`,
			`- Destructive: ${detail.spec.destructive ? 'yes' : 'no'}`,
			'',
			'## Input schema',
			'',
			`- \`${JSON.stringify(inputSchema)}\``,
		]
		if (outputSchema !== undefined) {
			lines.push('', '## Output schema', '', `- \`${JSON.stringify(outputSchema)}\``)
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'capability',
				id: detail.id,
				title: detail.title,
				description: detail.description,
				usage: `execute with codemode.${detail.spec.name}(args)`,
				requiredInputFields: detail.spec.requiredInputFields,
				readOnly: detail.spec.readOnly,
				idempotent: detail.spec.idempotent,
				destructive: detail.spec.destructive,
				inputSchema,
				...(outputSchema !== undefined ? { outputSchema } : {}),
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'skill') {
		const parameters = parseSkillParameters(detail.row.parameters)
		const inferredCapabilities =
			parseJsonStringArray(detail.row.inferred_capabilities) ?? []
		const usesCapabilities = parseJsonStringArray(detail.row.uses_capabilities)
		const lines = [
			`# Skill — ${detail.row.title}`,
			'',
			detail.row.description,
			'',
			'## Summary',
			'',
			`- Skill ID: \`${detail.row.id}\``,
			`- Collection: ${detail.row.collection_name ?? 'none'}`,
			`- Collection slug: ${detail.row.collection_slug ?? 'none'}`,
			`- Read-only: ${detail.row.read_only === 1 ? 'yes' : 'no'}`,
			`- Idempotent: ${detail.row.idempotent === 1 ? 'yes' : 'no'}`,
			`- Destructive: ${detail.row.destructive === 1 ? 'yes' : 'no'}`,
			'',
			'## Run this skill',
			'',
			`- \`codemode.meta_run_skill({ skill_id: "${detail.row.id}", params: { ... } })\``,
			'- Use `meta_get_skill` separately if you need the stored source code.',
		]
		if (parameters && parameters.length > 0) {
			lines.push('', '## Parameters', '')
			for (const parameter of parameters) {
				lines.push(
					`- \`${parameter.name}\` (${parameter.type}${parameter.required ? ', required' : ', optional'}) — ${parameter.description}`,
				)
			}
		}
		if (inferredCapabilities.length > 0 || usesCapabilities?.length) {
			lines.push('', '## Capability hints', '')
			if (inferredCapabilities.length > 0) {
				lines.push(`- Inferred capabilities: ${inferredCapabilities.join(', ')}`)
			}
			if (usesCapabilities && usesCapabilities.length > 0) {
				lines.push(`- Declared uses_capabilities: ${usesCapabilities.join(', ')}`)
			}
		}
		if (detail.row.search_text) {
			lines.push('', '## Search text', '', `- ${detail.row.search_text}`)
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'skill',
				id: detail.id,
				title: detail.title,
				description: detail.description,
				usage: `codemode.meta_run_skill({ skill_id: "${detail.row.id}", params: { ... } })`,
				collection: detail.row.collection_name,
				collectionSlug: detail.row.collection_slug,
				parameters,
				inferredCapabilities,
				usesCapabilities,
				searchText: detail.row.search_text,
				readOnly: detail.row.read_only === 1,
				idempotent: detail.row.idempotent === 1,
				destructive: detail.row.destructive === 1,
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'app') {
		const parameters = parseUiArtifactParameters(detail.row.parameters)
		const lines = [
			`# App — ${detail.row.title}`,
			'',
			detail.row.description,
			'',
			'## Summary',
			'',
			`- App ID: \`${detail.row.id}\``,
			`- Runtime: \`${detail.row.runtime}\``,
			`- Hidden: ${detail.row.hidden ? 'yes' : 'no'}`,
			'',
			'## Open this app',
			'',
			`- \`open_generated_ui({ app_id: "${detail.row.id}" })\``,
			`- Hosted URL: \`${detail.hostedUrl}\``,
		]
		if (parameters && parameters.length > 0) {
			lines.push('', '## Parameters', '')
			for (const parameter of parameters) {
				lines.push(
					`- \`${parameter.name}\` (${parameter.type}${parameter.required ? ', required' : ', optional'}) — ${parameter.description}`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'app',
				id: detail.id,
				title: detail.title,
				description: detail.description,
				usage: `open_generated_ui({ app_id: "${detail.row.id}" })`,
				hostedUrl: detail.hostedUrl,
				runtime: detail.row.runtime,
				parameters,
				hidden: detail.row.hidden,
			} satisfies SearchEntityDetailStructured,
		}
	}

	const lines = [
		`# Secret — \`${detail.row.name}\``,
		'',
		detail.row.description,
		'',
		'## Summary',
		'',
		`- Scope: \`${detail.row.scope}\``,
		`- Updated at: \`${detail.row.updatedAt}\``,
		'',
		'## Usage',
		'',
		`- Placeholder: \`{{secret:${detail.row.name}|scope=user}}\``,
		'- List secret metadata with `codemode.secret_list(...)` inside `execute` when needed.',
	]
	return {
		markdown: lines.join('\n'),
		structured: {
			kind: 'entity',
			type: 'secret',
			id: detail.id,
			title: detail.title,
			description: detail.description,
			usage: `{{secret:${detail.row.name}|scope=user}}`,
			scope: detail.row.scope,
			updatedAt: detail.row.updatedAt,
		} satisfies SearchEntityDetailStructured,
	}
}

function formatList(items: Array<string>) {
	if (items.length === 0) return 'none'
	return items.map((item) => `\`${item}\``).join(', ')
}
