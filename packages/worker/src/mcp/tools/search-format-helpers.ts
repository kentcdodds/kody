import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { type PackageJobSchedule } from '#worker/package-registry/types.ts'
import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'

import { type SearchEntityType } from './search-format-types.ts'

export { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'

export function buildPackageHostedUrl(
	baseUrl: string,
	username: string,
	kodyId: string,
) {
	return buildPackageAppUrl({ origin: baseUrl, username, kodyId })
}

export function buildEntityRef(id: string, type: SearchEntityType) {
	return `${id}:${type}`
}

export function buildCapabilityUsage(spec: {
	name: string
	source?: CapabilitySpec['source']
	remoteConnector?: CapabilitySpec['remoteConnector']
	mcpServer?: CapabilitySpec['mcpServer']
	openApi?: CapabilitySpec['openApi']
}) {
	return `execute with ${buildKodyCapabilityAccessor(spec)}(args)`
}

export const inlineCapabilityInputTypeMaxLength = 500

export function compactCapabilityInputTypeDefinition(
	inputTypeDefinition: string,
	maxLength = inlineCapabilityInputTypeMaxLength,
): { definition: string; truncated: boolean } {
	const collapsed = formatInlineTypeDefinition(inputTypeDefinition)
	if (collapsed.length <= maxLength) {
		return { definition: collapsed, truncated: false }
	}
	return {
		definition: `${collapsed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`,
		truncated: true,
	}
}

export function buildPackageMaintainSnippets(kodyId: string) {
	return {
		gitLane: `package_get_git_remote({ kody_id: ${JSON.stringify(kodyId)} })`,
		publish: `package_publish_external_push({ kody_id: ${JSON.stringify(kodyId)} })`,
	}
}

export function buildCapabilityExecuteExample(spec: CapabilitySpec) {
	return `import { kody } from 'kody:runtime'

export default async function main(input = {}) {
\treturn await ${buildKodyCapabilityAccessor(spec)}(input)
}`
}

export function buildPackageRootImportUsage(packageName: string) {
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
	if (input.functionName === 'home') {
		return `import action from ${JSON.stringify(importSpecifier)}`
	}
	return `import { ${input.functionName} } from ${JSON.stringify(importSpecifier)}`
}

export function getPrimaryPackageActionFunction<
	FunctionShape extends { name: string },
>(actionMatch: { functions: Array<FunctionShape> }) {
	return (
		actionMatch.functions.find((fn) => fn.name !== 'home') ??
		actionMatch.functions[0] ??
		null
	)
}

export function formatInlineTypeDefinition(typeDefinition: string) {
	return typeDefinition.replace(/\s+/g, ' ').trim()
}

export function buildValueUsage(name: string, scope: string) {
	return `kody.value_get({ name: ${JSON.stringify(name)}, scope: ${JSON.stringify(scope)} })`
}

export function buildIntegrationUsage(name: string) {
	return `kody.integration_get({ name: ${JSON.stringify(name)} })`
}

export function buildSecretUsage(name: string) {
	return /^[a-zA-Z0-9._-]+$/.test(name)
		? `{{secret:${name}|scope=user}}`
		: '(secret placeholder unavailable for this name)'
}

function formatOneLineSummary(value: string, maxLength = 180) {
	const summary = value.replace(/\s+/g, ' ').trim()
	if (summary.length <= maxLength) return summary
	return `${summary.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

export function formatOneLineSentence(value: string, maxLength?: number) {
	const summary = formatOneLineSummary(value, maxLength)
	if (!summary) return 'No description.'
	return /[.!?]$/.test(summary) ? summary : `${summary}.`
}

export function formatPackageSchedule(
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
		throw new McpCallerError(
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
		throw new McpCallerError(
			'Entity type must be one of: capability, package, secret, value, or integration.',
		)
	}
	if (!id) {
		throw new McpCallerError('Entity id must not be empty.')
	}
	return { id, type }
}

export function formatList(items: Array<string>) {
	if (items.length === 0) return 'none'
	return items.map((item) => `\`${item}\``).join(', ')
}

export function formatTtlMs(ttlMs: number | null) {
	if (ttlMs == null) return 'none'
	return `\`${ttlMs.toLocaleString()}\``
}
