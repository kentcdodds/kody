import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import { compressSchemaForLlm } from '#mcp/capabilities/schema-compression.ts'
import { type ConnectorConfig } from '#mcp/capabilities/values/connector-shared.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type UnifiedSearchMatch } from '#mcp/capabilities/unified-search.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { parseUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'

export type SearchEntityType =
	| 'capability'
	| 'app'
	| 'secret'
	| 'value'
	| 'connector'

export type SearchResultStructuredContent = {
	matches: Array<SlimSearchMatch>
	offline: boolean
	warnings: Array<string>
	memories?: {
		surfaced: Array<{
			id: string
			category: string | null
			status: string
			subject: string
			summary: string
			details: string
			tags: Array<string>
			updatedAt: string
		}>
		suppressedCount: number
		retrievalQuery: string
	}
	homeConnectorStatus?: {
		connectorKind: string
		connectorId: string
		state: string
		connected: boolean
		toolCount: number
	}
	remoteConnectorStatuses?: Array<{
		connectorKind: string
		connectorId: string
		state: string
		connected: boolean
		toolCount: number
	}>
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
			type: 'app'
			id: string
			title: string
			description: string
			usage: string
			hostedUrl: string | null
			hasClient: boolean
			hasServerCode: boolean
			taskNames: Array<string>
			jobNames: Array<string>
			scheduleSummaries: Array<string>
	  }
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			usage: string
	  }
	| {
			type: 'value'
			id: string
			name: string
			title: string
			description: string
			usage: string
			scope: string
			appId: string | null
	  }
	| {
			type: 'connector'
			id: string
			name: string
			title: string
			description: string
			usage: string
			flow: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
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
			type: 'app'
			id: string
			title: string
			description: string
			usage: string
			hostedUrl: string | null
			hasClient: boolean
			hasServerCode: boolean
			taskNames: Array<string>
			jobNames: Array<string>
			scheduleSummaries: Array<string>
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
	| {
			kind: 'entity'
			type: 'value'
			id: string
			title: string
			description: string
			usage: string
			scope: string
			appId: string | null
			value: string
			updatedAt: string
			ttlMs: number | null
	  }
	| {
			kind: 'entity'
			type: 'connector'
			id: string
			title: string
			description: string
			usage: string
			flow: ConnectorConfig['flow']
			tokenUrl: string
			apiBaseUrl: string | null
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			requiredHosts: Array<string>
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
			type: 'app'
			id: string
			title: string
			description: string
			row: UiArtifactRow
			hostedUrl: string | null
	  }
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			row: SecretSearchRow
	  }
	| {
			type: 'value'
			id: string
			title: string
			description: string
			row: ValueMetadata
	  }
	| {
			type: 'connector'
			id: string
			title: string
			description: string
			row: ValueMetadata
			config: ConnectorConfig
	  }

export function parseEntityRef(entity: string): {
	id: string
	type: SearchEntityType
} {
	const trimmed = entity.trim()
	const separator = trimmed.lastIndexOf(':')
	if (separator <= 0 || separator === trimmed.length - 1) {
		throw new Error(
			'Entity must use the format "{id}:{type}" where type is capability, app, secret, value, or connector.',
		)
	}
	const id = trimmed.slice(0, separator).trim()
	const type = trimmed.slice(separator + 1).trim()
	if (
		type !== 'capability' &&
		type !== 'app' &&
		type !== 'secret' &&
		type !== 'value' &&
		type !== 'connector'
	) {
		throw new Error(
			'Entity type must be one of: capability, app, secret, value, or connector.',
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
	includePreamble?: boolean
	memories?: {
		surfaced: Array<{
			category: string | null
			subject: string
			summary: string
		}>
		suppressedCount: number
	}
}) {
	const lines: Array<string> = ['# Search results', '']
	if (input.includePreamble ?? true) {
		lines.push(
			'For full detail on one hit, call `search` with `entity: "{id}:{type}"` (example: `kody_official_guide:capability`).',
			'',
			'**How to run matches:**',
			'',
			'- Built-in capabilities — `execute` / `codemode.<name>(args)`',
			'- Persisted values — `codemode.value_get({ name, scope })` or `codemode.value_list({ scope })`',
			'- Saved connectors — `codemode.connector_get({ name })` or `codemode.connector_list({})`',
			'- Saved apps — `app_get`, `app_list`, `app_save`, `app_run_task`, `app_run_job`, and `open_generated_ui({ app_id })` when the app has client UI',
			'- Secrets — placeholders in execute-time fetches or `codemode.secret_list` (never paste raw secrets in chat or embed `{{secret:...}}` literally into visible content such as comments, prompts, or issue bodies)',
		)
	}

	if (input.warnings.length > 0) {
		lines.push('', '## Warnings', '')
		for (const warning of input.warnings) {
			lines.push(`- ${warning}`)
		}
	}

	if (input.memories && input.memories.surfaced.length > 0) {
		lines.push('', '## Relevant memories', '')
		for (const memory of input.memories.surfaced) {
			const categorySuffix = memory.category ? ` (${memory.category})` : ''
			lines.push(`- **${memory.subject}**${categorySuffix}: ${memory.summary}`)
		}
		if (input.memories.suppressedCount > 0) {
			lines.push(
				`- ${String(input.memories.suppressedCount)} additional memory item(s) were suppressed for this conversation.`,
			)
		}
	}

	for (const match of input.matches) {
		lines.push('', ...formatMatchBlock(match, input.baseUrl))
	}

	if (input.matches.length === 0) {
		lines.push(
			'',
			'> **No matches.** Rephrase `query` or call `meta_list_capabilities` for the full capability registry. `entity` looks up a known id — it does not improve an empty ranked list.',
		)
	}

	if (
		input.matches.length > 0 &&
		input.matches.every((match) => match.type !== 'secret')
	) {
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
			'description' in match ? match.description : '',
		]
	}
	if (match.type === 'app') {
		const hostedUrl = match.hostedUrl ?? buildSavedUiUrl(baseUrl, match.appId)
		return [
			`## App — ${match.title}`,
			'',
			match.description,
			...(match.taskNames.length > 0
				? ['', `**Tasks:** ${match.taskNames.map((name) => `\`${name}\``).join(', ')}`]
				: []),
			...(match.jobNames.length > 0
				? ['', `**Jobs:** ${match.jobNames.map((name) => `\`${name}\``).join(', ')}`]
				: []),
			...(match.hostedUrl ? ['', `**Hosted URL:** \`${hostedUrl}\``] : []),
		]
	}
	if (match.type === 'value') {
		return [
			`## Value — \`${match.name}\` (\`${match.scope}\` scope)`,
			'',
			match.description,
			'',
			`**Entity:** \`${match.valueId}:value\``,
		]
	}
	if (match.type === 'connector') {
		return [
			`## Connector — \`${match.connectorName}\``,
			'',
			match.description,
			'',
			`**Flow:** \`${match.flow}\``,
			`**API base URL:** ${match.apiBaseUrl ? `\`${match.apiBaseUrl}\`` : 'none'}`,
		]
	}
	if (match.type === 'secret') {
		return [`## Secret — \`${match.name}\``, '', match.description]
	}
	return [String(match)]
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
		if (match.type === 'app') {
			return {
				type: 'app',
				id: match.appId,
				title: match.title,
				description: match.description,
				usage: match.usage,
				hostedUrl: match.hostedUrl,
				hasClient: match.hasClient,
				hasServerCode: match.hasServerCode,
				taskNames: match.taskNames,
				jobNames: match.jobNames,
				scheduleSummaries: match.scheduleSummaries,
			}
		}
		if (match.type === 'value') {
			return {
				type: 'value',
				id: match.valueId,
				name: match.name,
				title: match.name,
				description: match.description,
				usage: `codemode.value_get({ name: "${match.name}", scope: "${match.scope}" })`,
				scope: match.scope,
				appId: match.appId,
			}
		}
		if (match.type === 'connector') {
			return {
				type: 'connector',
				id: match.connectorName,
				name: match.connectorName,
				title: match.title,
				description: match.description,
				usage: `codemode.connector_get({ name: "${match.connectorName}" })`,
				flow: match.flow,
				apiBaseUrl: match.apiBaseUrl,
				requiredHosts: match.requiredHosts,
			}
		}
		if (match.type === 'secret') {
			return {
				type: 'secret',
				id: match.name,
				title: match.name,
				description: match.description,
				usage: `{{secret:${match.name}|scope=user}}`,
			}
		}
		throw new Error(`Unhandled search match type: ${match.type}`)
	})
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
			lines.push(
				'',
				'## Output schema',
				'',
				`- \`${JSON.stringify(outputSchema)}\``,
			)
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

	if (detail.type === 'app') {
		const parameters = parseUiArtifactParameters(detail.row.parameters)
		const hasServerCode = detail.row.hasServerCode
		const lines = [
			`# App — ${detail.row.title}`,
			'',
			detail.row.description,
			'',
			'## Summary',
			'',
			`- App ID: \`${detail.row.id}\``,
			`- Has client UI: ${detail.row.hasClient ? 'yes' : 'no'}`,
			`- Has backend: ${hasServerCode ? 'yes' : 'no'}`,
			`- Hidden: ${detail.row.hidden ? 'yes' : 'no'}`,
			...(detail.row.taskNames.length > 0
				? [`- Tasks: ${detail.row.taskNames.map((name) => `\`${name}\``).join(', ')}`]
				: []),
			...(detail.row.jobNames.length > 0
				? [`- Jobs: ${detail.row.jobNames.map((name) => `\`${name}\``).join(', ')}`]
				: []),
			...(detail.row.scheduleSummaries.length > 0
				? [`- Schedules: ${detail.row.scheduleSummaries.join(' | ')}`]
				: []),
			'',
			'## Use this app',
			'',
			...(detail.row.hasClient
				? [`- \`open_generated_ui({ app_id: "${detail.row.id}" })\``]
				: []),
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
			...(detail.row.taskNames.length > 0
				? [
						`- \`codemode.app_run_task({ app_id: "${detail.row.id}", task_name: "${detail.row.taskNames[0]}" })\``,
					]
				: []),
			...(detail.row.jobNames.length > 0
				? [
						`- \`codemode.app_run_job({ app_id: "${detail.row.id}", job_name: "${detail.row.jobNames[0]}" })\``,
					]
				: []),
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
				usage: detail.row.hasClient
					? `open_generated_ui({ app_id: "${detail.row.id}" })`
					: detail.row.taskNames.length > 0
						? `codemode.app_run_task({ app_id: "${detail.row.id}", task_name: "${detail.row.taskNames[0]}" })`
						: detail.row.jobNames.length > 0
							? `codemode.app_run_job({ app_id: "${detail.row.id}", job_name: "${detail.row.jobNames[0]}" })`
							: `codemode.app_get({ app_id: "${detail.row.id}" })`,
				hostedUrl: detail.hostedUrl,
				hasClient: detail.row.hasClient,
				hasServerCode,
				taskNames: detail.row.taskNames,
				jobNames: detail.row.jobNames,
				scheduleSummaries: detail.row.scheduleSummaries,
				parameters,
				hidden: detail.row.hidden,
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'value') {
		const lines = [
			`# Value — \`${detail.row.name}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Scope: \`${detail.row.scope}\``,
			`- App ID: ${detail.row.appId ? `\`${detail.row.appId}\`` : 'none'}`,
			`- Updated at: \`${detail.row.updatedAt}\``,
			`- TTL (ms): ${formatTtlMs(detail.row.ttlMs)}`,
			'',
			'## Read this value',
			'',
			`- \`codemode.value_get({ name: "${detail.row.name}", scope: "${detail.row.scope}" })\``,
			`- \`codemode.value_list({ scope: "${detail.row.scope}" })\``,
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
				title: detail.title,
				description: detail.description,
				usage: `codemode.value_get({ name: "${detail.row.name}", scope: "${detail.row.scope}" })`,
				scope: detail.row.scope,
				appId: detail.row.appId,
				value: detail.row.value,
				updatedAt: detail.row.updatedAt,
				ttlMs: detail.row.ttlMs,
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'connector') {
		const requiredHosts = detail.config.requiredHosts ?? []
		const lines = [
			`# Connector — \`${detail.config.name}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Flow: \`${detail.config.flow}\``,
			`- Token URL: \`${detail.config.tokenUrl}\``,
			`- API base URL: ${detail.config.apiBaseUrl ? `\`${detail.config.apiBaseUrl}\`` : 'none'}`,
			`- Required hosts: ${requiredHosts.length > 0 ? requiredHosts.map((host) => `\`${host}\``).join(', ') : 'none'}`,
			'',
			'## Read this connector',
			'',
			`- \`codemode.connector_get({ name: "${detail.config.name}" })\``,
			'- `codemode.connector_list({})`',
			'',
			'## Related stored names',
			'',
			`- Client ID value name: \`${detail.config.clientIdValueName}\``,
			`- Client secret secret name: ${detail.config.clientSecretSecretName ? `\`${detail.config.clientSecretSecretName}\`` : 'none'}`,
			`- Access token secret name: \`${detail.config.accessTokenSecretName}\``,
			`- Refresh token secret name: ${detail.config.refreshTokenSecretName ? `\`${detail.config.refreshTokenSecretName}\`` : 'none'}`,
		]
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'connector',
				id: detail.id,
				title: detail.title,
				description: detail.description,
				usage: `codemode.connector_get({ name: "${detail.config.name}" })`,
				flow: detail.config.flow,
				tokenUrl: detail.config.tokenUrl,
				apiBaseUrl: detail.config.apiBaseUrl ?? null,
				clientIdValueName: detail.config.clientIdValueName,
				clientSecretSecretName: detail.config.clientSecretSecretName ?? null,
				accessTokenSecretName: detail.config.accessTokenSecretName,
				refreshTokenSecretName: detail.config.refreshTokenSecretName ?? null,
				requiredHosts,
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
		'- Use placeholders only in execute-time fetch URL/header/body fields or capability inputs that explicitly opt into secret placeholders.',
		'- Do not place the literal placeholder token into visible content such as prompts, comments, issue bodies, logs, or returned strings.',
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

function formatTtlMs(ttlMs: number | null) {
	if (ttlMs == null) return 'none'
	return `\`${ttlMs.toLocaleString()}\``
}
