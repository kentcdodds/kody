import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type IntegrationConfig } from '#mcp/capabilities/values/integration-shared.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { buildPackageReadmeDetail } from '#worker/package-registry/package-readme.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import {
	type AuthoredPackageJson,
	type PackageJobSchedule,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	buildPackageSearchProjection,
	type PackageReferencedTypeProjection,
} from '#worker/package-registry/manifest.ts'
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
	| 'integration'

type SearchMatchType =
	| 'capability'
	| 'package'
	| 'value'
	| 'integration'
	| 'secret'
	| 'retriever_result'

export type PackageActionMatch = {
	subpath: string
	description: string | null
	typeDefinition: string | null
	functions: Array<{
		name: string
		description: string | null
		typeDefinition: string | null
	}>
	score: number
	matchedTerms: Array<string>
}

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
			readmeSnippet: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			actionMatches: Array<{
				subpath: string
				importSpecifier: string
				description: string | null
				typeDefinition: string | null
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
					usage: string
				}>
				score: number
				matchedTerms: Array<string>
			}>
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
			type: 'integration'
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
			executeExample: string
			requiredInputFields: Array<string>
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
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
				description: string | null
				typeDefinition: string | null
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
					referencedTypes: Array<PackageReferencedTypeProjection>
				}>
				referencedTypes: Array<PackageReferencedTypeProjection>
				// Full type source is no longer emitted by default; keep the nullable
				// field for structured-output compatibility with existing clients.
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
			readme: {
				path: string
				content: string
				truncated: boolean
			} | null
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
			type: 'integration'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			flow: IntegrationConfig['flow']
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
			type: 'integration'
			id: string
			title: string
			description: string
			row: ValueMetadata
			config: IntegrationConfig
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
			readmeSnippet?: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			actionMatches?: Array<PackageActionMatch>
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
			type: 'integration'
			integrationName: string
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

function buildEntityRef(id: string, type: SearchEntityType) {
	return `${id}:${type}`
}

function buildCapabilityUsage(name: string) {
	return `execute with ${buildCodemodeCapabilityAccessor(name)}(args)`
}

function buildCodemodeCapabilityAccessor(name: string) {
	if (/^[A-Za-z_$][\w$]*$/.test(name)) {
		return `codemode.${name}`
	}
	return `codemode[${JSON.stringify(name)}]`
}

function buildCapabilityExecuteExample(name: string) {
	return `import { codemode } from 'kody:runtime'

export default async function main(input = {}) {
\treturn await ${buildCodemodeCapabilityAccessor(name)}(input)
}`
}

function buildPackageRootImportUsage(packageName: string) {
	return `import entry from ${JSON.stringify(buildPackageImportSpecifier(packageName, '.'))}`
}

export function buildPackageActionImportUsage(input: {
	packageName: string
	subpath: string
	functionName: string
}) {
	const importSpecifier = buildPackageImportSpecifier(
		input.packageName,
		input.subpath,
	)
	if (input.functionName === 'default') {
		return `import action from ${JSON.stringify(importSpecifier)}`
	}
	return `import { ${input.functionName} } from ${JSON.stringify(importSpecifier)}`
}

export function getPrimaryPackageActionFunction<
	FunctionShape extends { name: string },
>(actionMatch: { functions: Array<FunctionShape> }) {
	return (
		actionMatch.functions.find((fn) => fn.name !== 'default') ??
		actionMatch.functions[0] ??
		null
	)
}

function formatInlineTypeDefinition(typeDefinition: string) {
	return typeDefinition.replace(/\s+/g, ' ').trim()
}

function buildPackageAppUsage(kodyId: string) {
	return `open_generated_ui({ kody_id: ${JSON.stringify(kodyId)} })`
}

function buildValueUsage(name: string, scope: string) {
	return `codemode.value_get({ name: ${JSON.stringify(name)}, scope: ${JSON.stringify(scope)} })`
}

function buildIntegrationUsage(name: string) {
	return `codemode.integration_get({ name: ${JSON.stringify(name)} })`
}

function buildSecretUsage(name: string) {
	return /^[a-zA-Z0-9._-]+$/.test(name)
		? `{{secret:${name}|scope=user}}`
		: '(secret placeholder unavailable for this name)'
}

function formatOneLineSummary(value: string, maxLength = 180) {
	const summary = value.replace(/\s+/g, ' ').trim()
	if (summary.length <= maxLength) return summary
	return `${summary.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function formatOneLineSentence(value: string) {
	const summary = formatOneLineSummary(value)
	if (!summary) return 'No description.'
	return /[.!?]$/.test(summary) ? summary : `${summary}.`
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
			'Entity must use the format "{id}:{type}" where type is capability, package, secret, value, or integration.',
		)
	}
	const id = trimmed.slice(0, separator).trim()
	const type = trimmed.slice(separator + 1).trim()
	if (
		type !== 'capability' &&
		type !== 'package' &&
		type !== 'secret' &&
		type !== 'value' &&
		type !== 'integration'
	) {
		throw new Error(
			'Entity type must be one of: capability, package, secret, value, or integration.',
		)
	}
	if (!id) {
		throw new Error('Entity id must not be empty.')
	}
	return { id, type }
}

export function formatSearchMarkdown(input: {
	matches: Array<SearchMatch>
	warnings?: Array<string>
	warningCount?: number
	includePreamble?: boolean
}) {
	const lines: Array<string> = ['# Search results', '']
	const hasEntityBackedMatch = input.matches.some(
		(match) => match.type !== 'retriever_result',
	)
	if ((input.includePreamble ?? true) && hasEntityBackedMatch) {
		lines.push(
			'For full detail on entity-backed hits, call `search` with `entity: "{id}:{type}"`.',
			'',
		)
	}

	if (input.matches.length === 0) {
		lines.push(
			'> **No matches.** Rephrase `query` or call `meta_list_capabilities` for the full capability registry. `entity` looks up a known id — it does not improve an empty ranked list.',
		)
	} else {
		input.matches.forEach((match, index) => {
			lines.push(formatMatchListItem(match, index))
		})
	}

	const warningCount = input.warningCount ?? input.warnings?.length ?? 0
	if (warningCount > 0) {
		lines.push(
			'',
			`> ${String(warningCount)} search notice(s) available in the structured result.`,
		)
	}

	return lines.join('\n').trim()
}

function formatMatchListItem(match: SearchMatch, index: number) {
	if (match.type === 'capability') {
		const entityRef = buildEntityRef(match.name, 'capability')
		return `${String(index + 1)}. **capability** ${formatMarkdownInlineCode(match.name)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'package') {
		const entityRef = buildEntityRef(match.kodyId, 'package')
		const [actionMatch] = match.actionMatches ?? []
		const actionFunction = actionMatch
			? getPrimaryPackageActionFunction(actionMatch)
			: null
		const actionSummary =
			actionMatch && actionFunction
				? ` Best action: ${formatMarkdownInlineCode(actionFunction.name)} via ${formatMarkdownInlineCode(buildPackageActionImportUsage({ packageName: match.name, subpath: actionMatch.subpath, functionName: actionFunction.name }))}${actionFunction.description ? ` — ${escapeMarkdownText(formatOneLineSentence(actionFunction.description))}` : ''}`
				: ''
		return `${String(index + 1)}. **package** ${escapeMarkdownText(match.title)} (${formatMarkdownInlineCode(match.kodyId)}) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}${actionSummary}`
	}
	if (match.type === 'value') {
		const entityRef = buildEntityRef(match.valueId, 'value')
		return `${String(index + 1)}. **value** ${formatMarkdownInlineCode(match.name)} (${formatMarkdownInlineCode(match.scope)} scope) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'integration') {
		const entityRef = buildEntityRef(match.integrationName, 'integration')
		return `${String(index + 1)}. **integration** ${formatMarkdownInlineCode(match.integrationName)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'retriever_result') {
		const source = match.source ?? `${match.kodyId}/${match.retrieverKey}`
		return `${String(index + 1)}. **retriever result** ${escapeMarkdownText(match.title)} — ${escapeMarkdownText(formatOneLineSentence(match.summary))} Source: ${formatMarkdownInlineCode(source)}`
	}
	const entityRef = buildEntityRef(match.name, 'secret')
	return `${String(index + 1)}. **secret** ${formatMarkdownInlineCode(match.name)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
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
				usage:
					primaryActionFunction?.usage ??
					openGeneratedUiUsage ??
					rootImportUsage,
				rootImportUsage,
				openGeneratedUiUsage,
				tags: match.tags,
				hasApp: match.hasApp,
				hostedUrl: match.hasApp
					? buildPackageHostedUrl(input.baseUrl, match.kodyId)
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

export function formatEntityDetailMarkdown(detail: SearchEntityDetail) {
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
			'## Execute from `execute`',
			'',
			'Built-in capabilities returned by `search` are available inside `execute` as methods on the imported `codemode` object.',
			'',
			'```ts',
			buildCapabilityExecuteExample(detail.spec.name),
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
				executeExample: buildCapabilityExecuteExample(detail.spec.name),
				requiredInputFields: detail.spec.requiredInputFields,
				readOnly: detail.spec.readOnly,
				idempotent: detail.spec.idempotent,
				destructive: detail.spec.destructive,
				inputTypeDefinition: detail.spec.inputTypeDefinition,
				...(detail.spec.outputTypeDefinition
					? { outputTypeDefinition: detail.spec.outputTypeDefinition }
					: {}),
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'package') {
		const exportProjection = buildPackageSearchProjection(
			detail.manifest,
			detail.files,
		)
		const exportDetails = exportProjection.exports.map((exportDetail) => ({
			...exportDetail,
			importSpecifier: buildPackageImportSpecifier(
				detail.record.name,
				exportDetail.subpath,
			),
			typesSource: null,
		}))
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
		const readme = buildPackageReadmeDetail({
			files: detail.files,
		})
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
				for (const exportedFunction of exportDetail.functions) {
					if (exportedFunction.description) {
						lines.push(
							`  - ${escapeMarkdownText(exportedFunction.description)}`,
						)
					}
					if (exportedFunction.typeDefinition) {
						lines.push(
							`  - \`${formatInlineTypeDefinition(exportedFunction.typeDefinition)}\``,
						)
					}
				}
				if (exportDetail.referencedTypes.length > 0) {
					lines.push('  - Referenced types:', '    ```ts')
					exportDetail.referencedTypes.forEach((referencedType, index) => {
						if (index > 0) lines.push('    ')
						lines.push(
							...referencedType.definition
								.split('\n')
								.map((line) => `    ${line}`),
						)
					})
					lines.push('    ```')
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
		if (readme) {
			lines.push(
				'',
				`## README (\`${readme.path}\`)`,
				'',
				readme.content,
				...(readme.truncated
					? ['', '> README content was truncated for this detail response.']
					: []),
			)
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
				readme,
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

	if (detail.type === 'integration') {
		const requiredHosts = detail.config.requiredHosts ?? []
		const lines = [
			`# Integration — \`${detail.config.name}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'integration')}\``,
			`- Flow: \`${detail.config.flow}\``,
			`- Token URL: \`${detail.config.tokenUrl}\``,
			`- API base URL: ${detail.config.apiBaseUrl ? `\`${detail.config.apiBaseUrl}\`` : 'none'}`,
			`- Required hosts: ${requiredHosts.length > 0 ? requiredHosts.map((host) => `\`${host}\``).join(', ') : 'none'}`,
			'',
			'## Read this integration',
			'',
			`- \`${buildIntegrationUsage(detail.config.name)}\``,
			'- `codemode.integration_list({})`',
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
				type: 'integration',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'integration'),
				title: detail.title,
				description: detail.description,
				usage: buildIntegrationUsage(detail.config.name),
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
