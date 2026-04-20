import { compressSchemaForLlm } from '#mcp/capabilities/schema-compression.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type ConnectorConfig } from '#mcp/capabilities/values/connector-shared.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type ToolTiming } from './tool-timing.ts'
import {
	type AuthoredPackageJson,
	type PackageJobSchedule,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'

export type SearchEntityType =
	| 'capability'
	| 'package'
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

export type SearchStructuredContent = {
	conversationId: string
	timing: ToolTiming
	result: SearchResultStructuredContent | SearchEntityDetailStructured
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
			type: 'package'
			id: string
			packageId: string
			kodyId: string
			title: string
			description: string
			usage: string
			tags: Array<string>
			hasApp: boolean
			hostedUrl: string | null
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
			type: 'package'
			id: string
			title: string
			description: string
			usage: string
			packageId: string
			kodyId: string
			name: string
			tags: Array<string>
			hasApp: boolean
			hostedUrl: string | null
			appEntry: string | null
			exports: Array<{
				subpath: string
				importSpecifier: string
				runtimeTarget: string | null
				typesPath: string | null
				typesSource: string | null
			}>
			jobs: Array<{
				name: string
				entry: string
				scheduleSummary: string
				enabled: boolean
			}>
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
			type: 'package'
			id: string
			title: string
			description: string
			record: SavedPackageRecord
			manifest: AuthoredPackageJson
			files: Record<string, string>
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

export type SearchMatch =
	| {
			type: 'capability'
			name: string
			description: string
	  }
	| {
			type: 'package'
			packageId: string
			kodyId: string
			name: string
			title: string
			description: string
			tags: Array<string>
			hasApp: boolean
	  }
	| {
			type: 'value'
			valueId: string
			name: string
			description: string
			scope: string
			appId: string | null
	  }
	| {
			type: 'connector'
			connectorName: string
			title: string
			description: string
			flow: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
	  }
	| {
			type: 'secret'
			name: string
			description: string
	  }

function buildPackageHostedUrl(baseUrl: string, kodyId: string) {
	return `${baseUrl.replace(/\/+$/, '')}/packages/${encodeURIComponent(kodyId)}`
}

function buildPackageImportSpecifier(kodyId: string, exportName: string) {
	if (exportName === '.') {
		return `kody:@${kodyId}`
	}
	return `kody:@${kodyId}/${exportName.replace(/^\.\//, '')}`
}

function formatPackageSchedule(
	schedule: PackageJobSchedule,
	timezone?: string,
) {
	if (schedule.type === 'cron') {
		return `Runs on cron "${schedule.expression}" in ${timezone?.trim() || 'UTC'}`
	}
	if (schedule.type === 'interval') {
		return `Runs every ${schedule.every}`
	}
	return `Runs once at ${schedule.runAt}`
}

export function parseEntityRef(entity: string): {
	id: string
	type: SearchEntityType
} {
	const trimmed = entity.trim()
	const separator = trimmed.lastIndexOf(':')
	if (separator <= 0 || separator === trimmed.length - 1) {
		throw new Error(
			'Entity must use the format "{id}:{type}" where type is capability, package, secret, value, or connector.',
		)
	}
	const id = trimmed.slice(0, separator).trim()
	const type = trimmed.slice(separator + 1).trim()
	if (
		type !== 'capability' &&
		type !== 'package' &&
		type !== 'secret' &&
		type !== 'value' &&
		type !== 'connector'
	) {
		throw new Error(
			'Entity type must be one of: capability, package, secret, value, or connector.',
		)
	}
	if (!id) {
		throw new Error('Entity id must not be empty.')
	}
	return { id, type }
}

export function formatSearchMarkdown(input: {
	matches: Array<SearchMatch>
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
			'- Built-in capabilities — `execute` with `import { codemode } from "kody:runtime"`',
			'- Persisted values — `codemode.value_get({ name, scope })` or `codemode.value_list({ scope })`',
			'- Saved connectors — `codemode.connector_get({ name })` or `codemode.connector_list({})`',
			'- Saved packages — import from `kody:@package-id/export-name`, edit with `repo_*`, and open package apps with `open_generated_ui({ package_id })` when the package declares `kody.app`',
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

function formatMatchBlock(match: SearchMatch, baseUrl: string) {
	if (match.type === 'capability') {
		return [
			`## Capability — \`${match.name}\``,
			'',
			'description' in match ? match.description : '',
		]
	}
	if (match.type === 'package') {
		const hostedUrl = match.hasApp
			? buildPackageHostedUrl(baseUrl, match.kodyId)
			: null
		return [
			`## Package — ${match.title} (\`${match.kodyId}\`)`,
			'',
			match.description,
			'',
			`**Tags:** ${match.tags.length > 0 ? match.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`**Has app:** ${match.hasApp ? 'yes' : 'no'}`,
			...(hostedUrl ? [`**Hosted URL:** \`${hostedUrl}\``] : []),
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
	return [`## Secret — \`${match.name}\``, '', match.description]
}

export function toSlimStructuredMatches(input: {
	matches: Array<SearchMatch>
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
		if (match.type === 'package') {
			return {
				type: 'package',
				id: match.kodyId,
				packageId: match.packageId,
				kodyId: match.kodyId,
				title: match.title,
				description: match.description,
				usage: match.hasApp
					? `open_generated_ui({ package_id: "${match.packageId}" })`
					: `import entry from "${buildPackageImportSpecifier(match.kodyId, '.')}"`,
				tags: match.tags,
				hasApp: match.hasApp,
				hostedUrl: match.hasApp
					? buildPackageHostedUrl(input.baseUrl, match.kodyId)
					: null,
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
		return {
			type: 'secret',
			id: match.name,
			title: match.name,
			description: match.description,
			usage: `{{secret:${match.name}|scope=user}}`,
		}
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

	if (detail.type === 'package') {
		const exportDetails = Object.entries(detail.manifest.exports).map(
			([exportName, target]) => {
				const runtimeTarget =
					typeof target === 'string'
						? target
						: (target.import ?? target.default ?? null)
				const typesPath =
					typeof target === 'string' ? null : (target.types ?? null)
				const typesSource =
					typesPath == null
						? null
						: (detail.files[typesPath.replace(/^\.?\//, '')] ?? null)
				return {
					subpath: exportName,
					importSpecifier: buildPackageImportSpecifier(
						detail.record.kodyId,
						exportName,
					),
					runtimeTarget,
					typesPath,
					typesSource,
				}
			},
		)
		const jobs = Object.entries(detail.manifest.kody.jobs ?? {}).map(
			([jobName, job]) => ({
				name: jobName,
				entry: job.entry,
				scheduleSummary: formatPackageSchedule(job.schedule, job.timezone),
				enabled: job.enabled ?? true,
			}),
		)
		const appEntry = detail.manifest.kody.app?.entry ?? null
		const lines = [
			`# Package — \`${detail.record.kodyId}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Package id: \`${detail.record.id}\``,
			`- Package name: \`${detail.record.name}\``,
			`- Kody id: \`${detail.record.kodyId}\``,
			`- Tags: ${detail.record.tags.length > 0 ? detail.record.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`- Has app: ${detail.record.hasApp ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
		]
		if (appEntry) {
			lines.push('', '## App', '', `- Entry: \`${appEntry}\``)
		}
		if (exportDetails.length > 0) {
			lines.push('', '## Exports', '')
			for (const exportDetail of exportDetails) {
				lines.push(
					`- \`${exportDetail.subpath}\` -> \`${exportDetail.importSpecifier}\`${exportDetail.runtimeTarget ? ` (runtime target: \`${exportDetail.runtimeTarget}\`)` : ''}${exportDetail.typesPath ? ` (types: \`${exportDetail.typesPath}\`)` : ''}`,
				)
				if (exportDetail.typesSource) {
					lines.push('', '  Type definitions:', '', '  ```ts')
					lines.push(
						...exportDetail.typesSource.split('\n').map((line) => `  ${line}`),
					)
					lines.push('  ```')
				}
			}
		}
		if (jobs.length > 0) {
			lines.push('', '## Jobs', '')
			for (const job of jobs) {
				lines.push(
					`- \`${job.name}\` -> \`${job.entry}\` — ${job.scheduleSummary}${job.enabled ? '' : ' (disabled)'}`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'package',
				id: detail.record.kodyId,
				title: detail.title,
				description: detail.description,
				usage: detail.record.hasApp
					? `open_generated_ui({ package_id: "${detail.record.id}" })`
					: `import entry from "${buildPackageImportSpecifier(detail.record.kodyId, '.')}"`,
				packageId: detail.record.id,
				kodyId: detail.record.kodyId,
				name: detail.record.name,
				tags: detail.record.tags,
				hasApp: detail.record.hasApp,
				hostedUrl: detail.hostedUrl,
				appEntry,
				exports: exportDetails,
				jobs,
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
