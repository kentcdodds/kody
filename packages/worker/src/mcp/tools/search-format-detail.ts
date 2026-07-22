import { buildExternalPackageInvocationDescriptor } from '#worker/package-invocations/public-url.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { buildPackageReadmeDetail } from '#worker/package-registry/package-readme.ts'

import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import {
	buildCapabilityExecuteExample,
	buildCapabilityUsage,
	buildEntityRef,
	buildIntegrationUsage,
	buildPackageMaintainSnippets,
	buildPackageRootImportUsage,
	buildSecretUsage,
	buildValueUsage,
	formatInlineTypeDefinition,
	formatList,
	formatOneLineSentence,
	formatPackageSchedule,
	formatTtlMs,
} from './search-format-helpers.ts'
import {
	type SearchEntityDetail,
	type SearchEntityDetailStructured,
} from './search-format-types.ts'

export function formatEntityDetailMarkdown(detail: SearchEntityDetail) {
	if (detail.type === 'capability') {
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
			externalInvocation: detail.ownerUsername
				? buildExternalPackageInvocationDescriptor({
						baseUrl: detail.baseUrl,
						ownerUsername: detail.ownerUsername,
						kodyId: detail.record.kodyId,
						exportName: exportDetail.subpath,
					})
				: null,
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
		const maintain = buildPackageMaintainSnippets(detail.record.kodyId)
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
			`- Hidden: ${detail.record.hidden ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
			'',
			'## Maintain',
			'',
			`- Git lane: \`${maintain.gitLane}\` → clone → edit → push → \`${maintain.publish}\``,
			'- Tool-only: `package_save` / repo sessions; full guide: `coding_guide_get({ guide: "package_authoring" })`',
		]
		if (appEntry) {
			lines.push(
				'',
				'## App',
				'',
				`- Entry: \`${appEntry}\``,
				...(detail.hostedUrl ? [`- Open: \`${detail.hostedUrl}\``] : []),
			)
		}
		if (exportDetails.length > 0) {
			lines.push('', '## Exports', '')
			for (const exportDetail of exportDetails) {
				lines.push(
					`- \`${exportDetail.subpath}\` -> \`${exportDetail.importSpecifier}\`${exportDetail.runtimeTarget ? ` (runtime target: \`${exportDetail.runtimeTarget}\`)` : ''}${exportDetail.typesPath ? ` (types: \`${exportDetail.typesPath}\`)` : ''}`,
				)
				if (exportDetail.externalInvocation) {
					lines.push(
						`  - External invocation: \`${exportDetail.externalInvocation.method} ${exportDetail.externalInvocation.url}\``,
						`  - Route export name: \`${exportDetail.externalInvocation.routeExportName}\`; normalized export name for token scope checks: \`${exportDetail.externalInvocation.normalizedExportName}\``,
						`  - Token setup URL: \`${exportDetail.externalInvocation.tokenSetupUrl}\` (setup only; not an invocation URL)`,
						`  - Source: ${escapeMarkdownText(exportDetail.externalInvocation.sourceGuidance)}`,
					)
				}
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
				usage: buildPackageRootImportUsage(detail.record.name),
				packageId: detail.record.id,
				kodyId: detail.record.kodyId,
				name: detail.record.name,
				tags: detail.record.tags,
				hasApp: detail.record.hasApp,
				hidden: detail.record.hidden,
				hostedUrl: detail.hostedUrl,
				appEntry,
				maintain,
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
			} satisfies SearchEntityDetailStructured,
		}
	}

	if (detail.type === 'integration') {
		const requiredHosts = detail.config.requiredHosts ?? []
		const authorization = detail.config.authorization ?? null
		const relatedPackageSuggestions = detail.relatedPackageSuggestions ?? []
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
			`- Authorize URL: ${authorization ? `\`${authorization.authorizeUrl}\`` : 'none'}`,
			`- Scopes: ${authorization && authorization.scopes.length > 0 ? authorization.scopes.map((scope) => `\`${scope}\``).join(', ') : 'none'}`,
			'',
			'## Read this integration',
			'',
			`- \`${buildIntegrationUsage(detail.config.name)}\``,
			'- `kody.integration_list({})`',
			'',
			'## Related stored names',
			'',
			`- Client ID value name: \`${detail.config.clientIdValueName}\``,
			`- Client secret secret name: ${detail.config.clientSecretSecretName ? `\`${detail.config.clientSecretSecretName}\`` : 'none'}`,
			`- Access token secret name: \`${detail.config.accessTokenSecretName}\``,
			`- Refresh token secret name: ${detail.config.refreshTokenSecretName ? `\`${detail.config.refreshTokenSecretName}\`` : 'none'}`,
		]
		if (authorization) {
			lines.push(
				'',
				'## OAuth authorization metadata',
				'',
				`- Scope separator: ${authorization.scopeSeparator ? `\`${authorization.scopeSeparator}\`` : 'default single space'}`,
				`- Extra authorize params: ${
					Object.keys(authorization.extraAuthorizeParams ?? {}).length > 0
						? Object.entries(authorization.extraAuthorizeParams ?? {})
								.map(([key, value]) => `\`${key}=${value}\``)
								.join(', ')
						: 'none'
				}`,
				'',
				`Reconnect with \`/connect/oauth?provider=${encodeURIComponent(detail.config.name)}\`; Kody derives the provider authorize URL from the saved integration metadata plus the current client credentials.`,
			)
		}
		if (relatedPackageSuggestions.length > 0) {
			lines.push(
				'',
				'## Related packages',
				'',
				'Integrations store auth config. Packages are the agent API for this provider — inspect or fork one of these instead of treating the integration alone as the end state.',
				'',
			)
			for (const suggestion of relatedPackageSuggestions) {
				if (suggestion.source === 'user') {
					lines.push(
						`- **user** ${formatMarkdownInlineCode(suggestion.kodyId)} (${formatMarkdownInlineCode(suggestion.name)}) — ${escapeMarkdownText(formatOneLineSentence(suggestion.description))} Entity: ${formatMarkdownInlineCode(suggestion.entityRef)}`,
					)
					continue
				}
				const trustLabel = suggestion.trusted
					? 'community (trusted)'
					: 'community'
				lines.push(
					`- **${trustLabel}** ${formatMarkdownInlineCode(suggestion.kodyId)} (${formatMarkdownInlineCode(suggestion.name)}) — ${escapeMarkdownText(formatOneLineSentence(suggestion.description))} Listing: ${formatMarkdownInlineCode(suggestion.listingId)} · ${formatMarkdownInlineCode(suggestion.publicUrl)}`,
				)
			}
		}
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
				authorization,
				...(relatedPackageSuggestions.length > 0
					? { relatedPackageSuggestions }
					: {}),
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
		'- List secret metadata with `kody.secret_list(...)` inside `execute` when needed.',
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
