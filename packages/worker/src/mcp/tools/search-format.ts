import { compressSchemaForLlm } from '#mcp/capabilities/schema-compression.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type ConnectorConfig } from '#mcp/capabilities/values/connector-shared.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import {
	type AuthoredPackageJson,
	type PackageJobSchedule,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'

export type SearchEntityType =
	| 'capability'
	| 'package'
	| 'secret'
	| 'value'
	| 'connector'

type SearchMatchType =
	| 'capability'
	| 'package'
	| 'value'
	| 'connector'
	| 'secret'
	| 'retriever_result'

export type SearchResultStructuredContent = {
	matches: Array<SlimSearchMatch>
	offline: boolean
	warnings: Array<string>
	guidance?: string
	telemetry?: {
		intent: {
			task: string
			confidence: number
			entityCount: number
			actionCount: number
			constraintCount: number
			topEntities: Array<{
				type: string
				id: string
				confidence: number
			}>
		}
		candidateCounts: Partial<Record<SearchMatchType, number>>
		topResultTypes: Array<SearchMatchType>
		trimmedMatchCount?: number
		responseTrimmed?: boolean
	}
	phaseTimings?: {
		queryUnderstandingMs: number
		candidateGenerationMs: number
		rerankingMs: number
		formattingMs?: number
	}
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
		retrieverResults?: Array<PackageRetrieverSurfaceResult>
		retrieverWarnings?: Array<string>
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
			entityRef: string
			title: string
			description: string
			usage: string
	  }
	| {
			type: 'package'
			id: string
			entityRef: string
			packageId: string
			kodyId: string
			title: string
			description: string
			usage: string
			rootImportUsage: string
			openGeneratedUiUsage: string | null
			tags: Array<string>
			hasApp: boolean
			hostedUrl: string | null
			nextStep?: string
	  }
	| {
			type: 'secret'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
	  }
	| {
			type: 'value'
			id: string
			entityRef: string
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
			entityRef: string
			name: string
			title: string
			description: string
			usage: string
			flow: string
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			nextStep?: string
	  }
	| {
			type: 'retriever_result'
			id: string
			title: string
			summary: string
			details: string | null
			source: string
			url: string | null
			score: number | null
			packageId: string
			kodyId: string
			retrieverKey: string
			retrieverName: string
	  }

export type SearchEntityDetailStructured =
	| {
			kind: 'entity'
			type: 'capability'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			requiredInputFields: Array<string>
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
			inputSchema?: unknown
			outputSchema?: unknown
			inputTypeDefinition: string
			outputTypeDefinition?: string
	  }
	| {
			kind: 'entity'
			type: 'package'
			id: string
			entityRef: string
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
			retrievers: Array<{
				key: string
				exportName: string
				name: string
				description: string
				scopes: Array<string>
				timeoutMs: number | null
				maxResults: number | null
			}>
	  }
	| {
			kind: 'entity'
			type: 'secret'
			id: string
			entityRef: string
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
			entityRef: string
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
			entityRef: string
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
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
	  }
	| {
			type: 'secret'
			name: string
			description: string
	  }
	| (PackageRetrieverSurfaceResult & {
			type: 'retriever_result'
	  })

function buildPackageHostedUrl(baseUrl: string, kodyId: string) {
	return `${baseUrl.replace(/\/+$/, '')}/packages/${encodeURIComponent(kodyId)}`
}

function buildPackageImportSpecifier(packageName: string, exportName: string) {
	if (exportName === '.') {
		return `kody:${packageName}`
	}
	return `kody:${packageName}/${exportName.replace(/^\.\//, '')}`
}

function buildEntityRef(id: string, type: SearchEntityType) {
	return `${id}:${type}`
}

function buildCapabilityUsage(name: string) {
	return `execute with codemode.${name}(args)`
}

function buildPackageRootImportUsage(packageName: string) {
	return `import entry from ${JSON.stringify(buildPackageImportSpecifier(packageName, '.'))}`
}

function buildPackageAppUsage(kodyId: string) {
	return `open_generated_ui({ kody_id: ${JSON.stringify(kodyId)} })`
}

function buildValueUsage(name: string, scope: string) {
	return `codemode.value_get({ name: ${JSON.stringify(name)}, scope: ${JSON.stringify(scope)} })`
}

function buildConnectorUsage(name: string) {
	return `codemode.connector_get({ name: ${JSON.stringify(name)} })`
}

function buildSecretUsage(name: string) {
	return /^[a-zA-Z0-9._-]+$/.test(name)
		? `{{secret:${name}|scope=user}}`
		: '(secret placeholder unavailable for this name)'
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
	guidance?: string
	memories?: {
		surfaced: Array<{
			category: string | null
			subject: string
			summary: string
		}>
		suppressedCount: number
		retrieverResults?: Array<PackageRetrieverSurfaceResult>
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
			'- Saved packages — import from `kody:@scope/package-name/export-name`, edit with `repo_*`, and open package apps with `open_generated_ui({ kody_id })` when the package declares `kody.app`',
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
	if (input.memories?.retrieverResults?.length) {
		lines.push('', '## Relevant retriever results', '')
		for (const result of input.memories.retrieverResults) {
			lines.push(
				`- **${escapeMarkdownText(result.title)}** — ${escapeMarkdownText(result.summary)} (${formatMarkdownInlineCode(`${result.kodyId}/${result.retrieverKey}`)})`,
			)
		}
	}

	if (input.guidance?.trim()) {
		lines.push('', '## Recommended next step', '', input.guidance.trim())
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
		const entityRef = buildEntityRef(match.name, 'capability')
		return [
			`## Capability — \`${match.name}\``,
			'',
			'description' in match ? match.description : '',
			'',
			`**Entity:** \`${entityRef}\``,
			`**Run:** \`${buildCapabilityUsage(match.name)}\``,
		]
	}
	if (match.type === 'package') {
		const hostedUrl = match.hasApp
			? buildPackageHostedUrl(baseUrl, match.kodyId)
			: null
		const entityRef = buildEntityRef(match.kodyId, 'package')
		const rootImportUsage = buildPackageRootImportUsage(match.name)
		const openGeneratedUiUsage = match.hasApp
			? buildPackageAppUsage(match.kodyId)
			: null
		return [
			`## Package — ${match.title} (\`${match.kodyId}\`)`,
			'',
			match.description,
			'',
			`**Entity:** \`${entityRef}\``,
			`**Package ID:** \`${match.packageId}\``,
			...(openGeneratedUiUsage
				? [`**Open app:** \`${openGeneratedUiUsage}\``]
				: []),
			`**Import:** \`${rootImportUsage}\``,
			`**Tags:** ${match.tags.length > 0 ? match.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`**Has app:** ${match.hasApp ? 'yes' : 'no'}`,
			...(hostedUrl ? [`**Hosted URL:** \`${hostedUrl}\``] : []),
		]
	}
	if (match.type === 'value') {
		const entityRef = buildEntityRef(match.valueId, 'value')
		return [
			`## Value — \`${match.name}\` (\`${match.scope}\` scope)`,
			'',
			match.description,
			'',
			`**Entity:** \`${entityRef}\``,
			`**Read:** \`${buildValueUsage(match.name, match.scope)}\``,
		]
	}
	if (match.type === 'connector') {
		const entityRef = buildEntityRef(match.connectorName, 'connector')
		return [
			`## Connector — \`${match.connectorName}\``,
			'',
			match.description,
			'',
			`**Entity:** \`${entityRef}\``,
			`**Read:** \`${buildConnectorUsage(match.connectorName)}\``,
			`**Flow:** \`${match.flow}\``,
			`**Token URL:** \`${match.tokenUrl}\``,
			`**API base URL:** ${match.apiBaseUrl ? `\`${match.apiBaseUrl}\`` : 'none'}`,
			`**Required hosts:** ${formatList(match.requiredHosts)}`,
			`**Client ID value:** \`${match.clientIdValueName}\``,
			`**Client secret secret:** ${match.clientSecretSecretName ? `\`${match.clientSecretSecretName}\`` : 'none'}`,
			`**Access token secret:** \`${match.accessTokenSecretName}\``,
			`**Refresh token secret:** ${match.refreshTokenSecretName ? `\`${match.refreshTokenSecretName}\`` : 'none'}`,
		]
	}
	if (match.type === 'retriever_result') {
		const source = match.source ?? `${match.kodyId}/${match.retrieverKey}`
		return [
			`## Retrieved context — ${escapeMarkdownText(match.title)}`,
			'',
			escapeMarkdownText(match.summary),
			...(match.details ? ['', escapeMarkdownText(match.details)] : []),
			'',
			`**Source:** ${formatMarkdownInlineCode(source)}`,
			`**Package:** ${formatMarkdownInlineCode(match.kodyId)}`,
			`**Retriever:** ${formatMarkdownInlineCode(match.retrieverName)}`,
			...(match.url ? [`**URL:** ${formatMarkdownInlineCode(match.url)}`] : []),
		]
	}
	return [
		`## Secret — \`${match.name}\``,
		'',
		match.description,
		'',
		`**Entity:** \`${buildEntityRef(match.name, 'secret')}\``,
		`**Usage:** \`${buildSecretUsage(match.name)}\``,
	]
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
				entityRef: buildEntityRef(match.name, 'capability'),
				title: match.name,
				description:
					'description' in match && typeof match.description === 'string'
						? match.description
						: '',
				usage: buildCapabilityUsage(match.name),
			}
		}
		if (match.type === 'package') {
			const rootImportUsage = buildPackageRootImportUsage(match.name)
			const openGeneratedUiUsage = match.hasApp
				? buildPackageAppUsage(match.kodyId)
				: null
			const nextStep = match.hasApp
				? `Open the app with open_generated_ui({ kody_id: "${match.kodyId}" }) or inspect package detail with search({ entity: "${match.kodyId}:package" }).`
				: `Inspect package detail with search({ entity: "${match.kodyId}:package" }) to review exports, then import the needed entry from "${buildPackageImportSpecifier(match.name, '.')}".`
			return {
				type: 'package',
				id: match.kodyId,
				entityRef: buildEntityRef(match.kodyId, 'package'),
				packageId: match.packageId,
				kodyId: match.kodyId,
				title: match.title,
				description: match.description,
				usage: openGeneratedUiUsage ?? rootImportUsage,
				rootImportUsage,
				openGeneratedUiUsage,
				tags: match.tags,
				hasApp: match.hasApp,
				hostedUrl: match.hasApp
					? buildPackageHostedUrl(input.baseUrl, match.kodyId)
					: null,
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
		if (match.type === 'connector') {
			return {
				type: 'connector',
				id: match.connectorName,
				entityRef: buildEntityRef(match.connectorName, 'connector'),
				name: match.connectorName,
				title: match.title,
				description: match.description,
				usage: buildConnectorUsage(match.connectorName),
				flow: match.flow,
				tokenUrl: match.tokenUrl,
				apiBaseUrl: match.apiBaseUrl,
				requiredHosts: match.requiredHosts,
				clientIdValueName: match.clientIdValueName,
				clientSecretSecretName: match.clientSecretSecretName,
				accessTokenSecretName: match.accessTokenSecretName,
				refreshTokenSecretName: match.refreshTokenSecretName,
				nextStep: `Inspect connector detail with search({ entity: "${match.connectorName}:connector" }) and then run a minimal authenticated execute smoke test before building or calling integration-backed code.`,
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

export function formatEntityDetailMarkdown(
	detail: SearchEntityDetail,
	options?: { includeSchemas?: boolean },
) {
	if (detail.type === 'capability') {
		const lines = [
			`# Capability — \`${detail.spec.name}\``,
			'',
			detail.spec.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'capability')}\``,
			`- Domain: \`${detail.spec.domain}\``,
			`- Required input fields: ${formatList(detail.spec.requiredInputFields)}`,
			`- Read-only: ${detail.spec.readOnly ? 'yes' : 'no'}`,
			`- Idempotent: ${detail.spec.idempotent ? 'yes' : 'no'}`,
			`- Destructive: ${detail.spec.destructive ? 'yes' : 'no'}`,
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
		const includeSchemas = options?.includeSchemas === true
		const inputSchema = includeSchemas
			? compressSchemaForLlm(detail.spec.inputSchema)
			: undefined
		const outputSchema =
			includeSchemas && detail.spec.outputSchema != null
				? compressSchemaForLlm(detail.spec.outputSchema, {
						stripRootObjectType: false,
					})
				: undefined
		if (includeSchemas) {
			lines.push(
				'',
				'## Input schema',
				'',
				`- \`${JSON.stringify(inputSchema)}\``,
			)
		}
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
				entityRef: buildEntityRef(detail.id, 'capability'),
				title: detail.title,
				description: detail.description,
				usage: buildCapabilityUsage(detail.spec.name),
				requiredInputFields: detail.spec.requiredInputFields,
				readOnly: detail.spec.readOnly,
				idempotent: detail.spec.idempotent,
				destructive: detail.spec.destructive,
				...(includeSchemas ? { inputSchema } : {}),
				...(outputSchema !== undefined ? { outputSchema } : {}),
				inputTypeDefinition: detail.spec.inputTypeDefinition,
				...(detail.spec.outputTypeDefinition
					? { outputTypeDefinition: detail.spec.outputTypeDefinition }
					: {}),
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
						detail.record.name,
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
		const retrievers = Object.entries(
			detail.manifest.kody.retrievers ?? {},
		).map(([key, retriever]) => ({
			key,
			exportName: retriever.export,
			name: retriever.name,
			description: retriever.description,
			scopes: retriever.scopes,
			timeoutMs: retriever.timeoutMs ?? null,
			maxResults: retriever.maxResults ?? null,
		}))
		const appEntry = detail.manifest.kody.app?.entry ?? null
		const lines = [
			`# Package — \`${detail.record.kodyId}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.record.kodyId, 'package')}\``,
			`- Package id: \`${detail.record.id}\``,
			`- Package name: \`${detail.record.name}\``,
			`- Kody id: \`${detail.record.kodyId}\``,
			`- Tags: ${detail.record.tags.length > 0 ? detail.record.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`- Has app: ${detail.record.hasApp ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
		]
		if (appEntry) {
			lines.push(
				'',
				'## App',
				'',
				`- Entry: \`${appEntry}\``,
				`- Open: \`${buildPackageAppUsage(detail.record.kodyId)}\``,
			)
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
		if (retrievers.length > 0) {
			lines.push('', '## Retrievers', '')
			for (const retriever of retrievers) {
				lines.push(
					`- ${formatMarkdownInlineCode(retriever.key)} -> ${formatMarkdownInlineCode(retriever.exportName)} — ${escapeMarkdownText(retriever.description)} (scopes: ${retriever.scopes.map((scope) => formatMarkdownInlineCode(scope)).join(', ')})`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'package',
				id: detail.record.kodyId,
				entityRef: buildEntityRef(detail.record.kodyId, 'package'),
				title: detail.title,
				description: detail.description,
				usage: detail.record.hasApp
					? buildPackageAppUsage(detail.record.kodyId)
					: buildPackageRootImportUsage(detail.record.name),
				packageId: detail.record.id,
				kodyId: detail.record.kodyId,
				name: detail.record.name,
				tags: detail.record.tags,
				hasApp: detail.record.hasApp,
				hostedUrl: detail.hostedUrl,
				appEntry,
				exports: exportDetails,
				jobs,
				retrievers,
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
			`- Entity: \`${buildEntityRef(detail.id, 'value')}\``,
			`- Scope: \`${detail.row.scope}\``,
			`- App ID: ${detail.row.appId ? `\`${detail.row.appId}\`` : 'none'}`,
			`- Updated at: \`${detail.row.updatedAt}\``,
			`- TTL (ms): ${formatTtlMs(detail.row.ttlMs)}`,
			'',
			'## Read this value',
			'',
			`- \`${buildValueUsage(detail.row.name, detail.row.scope)}\``,
			`- \`codemode.value_list({ scope: ${JSON.stringify(detail.row.scope)} })\``,
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
			`- Entity: \`${buildEntityRef(detail.id, 'connector')}\``,
			`- Flow: \`${detail.config.flow}\``,
			`- Token URL: \`${detail.config.tokenUrl}\``,
			`- API base URL: ${detail.config.apiBaseUrl ? `\`${detail.config.apiBaseUrl}\`` : 'none'}`,
			`- Required hosts: ${requiredHosts.length > 0 ? requiredHosts.map((host) => `\`${host}\``).join(', ') : 'none'}`,
			'',
			'## Read this connector',
			'',
			`- \`${buildConnectorUsage(detail.config.name)}\``,
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
				entityRef: buildEntityRef(detail.id, 'connector'),
				title: detail.title,
				description: detail.description,
				usage: buildConnectorUsage(detail.config.name),
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
		`- Entity: \`${buildEntityRef(detail.id, 'secret')}\``,
		`- Scope: \`${detail.row.scope}\``,
		`- Updated at: \`${detail.row.updatedAt}\``,
		'',
		'## Usage',
		'',
		`- Placeholder: \`${buildSecretUsage(detail.row.name)}\``,
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
			entityRef: buildEntityRef(detail.id, 'secret'),
			title: detail.title,
			description: detail.description,
			usage: buildSecretUsage(detail.row.name),
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
