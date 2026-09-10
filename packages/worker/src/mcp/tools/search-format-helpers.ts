import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { type PackageJobSchedule } from '#worker/package-registry/types.ts'
import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'

import {
	searchEntityRefTypes,
	type SearchEntityType,
} from './search-format-types.ts'

export { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'

export function buildPackageHostedUrl(input: {
	packageAppBaseUrl: string | null
	appBaseUrl: string
	username: string
	kodyId: string
}) {
	return resolveHostedPackageAppUrl(input)
}

export function buildEntityRef(
	id: string,
	type: SearchEntityType,
	section?: string,
) {
	const ref = `${id}:${type}`
	return section ? `${ref}#${section}` : ref
}

export function buildCapabilityUsage(spec: {
	name: string
	source?: CapabilitySpec['source']
	mcpServer?: CapabilitySpec['mcpServer']
}) {
	return `execute with ${buildKodyCapabilityAccessor(spec)}(args)`
}

export const inlineCapabilityInputTypeMaxLength = 500

export function compactCapabilityInputTypeDefinition(
	inputTypeDefinition: string,
	options: {
		maxLength?: number
		requiredInputFields?: ReadonlyArray<string>
	} = {},
): { definition: string; truncated: boolean } {
	const maxLength = options.maxLength ?? inlineCapabilityInputTypeMaxLength
	const collapsed = formatInlineTypeDefinition(inputTypeDefinition)
	if (collapsed.length <= maxLength) {
		return { definition: collapsed, truncated: false }
	}
	const requiredFields = options.requiredInputFields ?? []
	const requiredFieldsMarker =
		requiredFields.length > 0
			? ` /* required fields: ${requiredFields.join(', ')} */`
			: ''
	const suffix = `...${requiredFieldsMarker}`
	const prefixLength = Math.max(0, maxLength - suffix.length)
	return {
		definition: `${collapsed.slice(0, prefixLength).trimEnd()}${suffix}`,
		truncated: true,
	}
}

export function buildPackageMaintainSnippets(kodyId: string) {
	return {
		gitLane: `packageGetGitRemote({ package_name: ${JSON.stringify(kodyId)} })`,
		publish: `packagePublishExternalPush({ package_name: ${JSON.stringify(kodyId)} })`,
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

export function buildIntegrationUsage(name: string) {
	return `kody.integrationGet({ name: ${JSON.stringify(name)} })`
}

export function buildSecretUsage(name: string) {
	return /^[a-zA-Z0-9._-]+$/.test(name)
		? `{{secret:${name}|scope=user}}`
		: '(secret placeholder unavailable for this name)'
}

export function buildGuideUsage(id: string) {
	return `search({ entity: ${JSON.stringify(buildEntityRef(id, 'guide'))} })`
}

export function formatSearchEntityRefTypeList() {
	const types = [...searchEntityRefTypes]
	if (types.length <= 1) return types[0] ?? ''
	return `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`
}

function isSearchEntityRefType(type: string): type is SearchEntityType {
	return (searchEntityRefTypes as ReadonlyArray<string>).includes(type)
}

function decodeEntitySection(raw: string) {
	const trimmed = raw.trim()
	if (!trimmed) return undefined
	try {
		return decodeURIComponent(trimmed.replace(/\+/g, ' ')).trim() || undefined
	} catch {
		return trimmed
	}
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
	section?: string
} {
	const trimmed = entity.trim()
	const hash = trimmed.lastIndexOf('#')
	const colon = trimmed.lastIndexOf(':')
	const hasSectionFragment = hash > colon && colon > 0
	const section = hasSectionFragment
		? decodeEntitySection(trimmed.slice(hash + 1))
		: undefined
	const withoutSection = hasSectionFragment ? trimmed.slice(0, hash) : trimmed
	const separator = withoutSection.lastIndexOf(':')
	if (separator <= 0 || separator === withoutSection.length - 1) {
		throw new McpCallerError(
			`Entity must use the format "{id}:{type}" where type is ${formatSearchEntityRefTypeList()}.`,
		)
	}
	const id = withoutSection.slice(0, separator).trim()
	const type = withoutSection.slice(separator + 1).trim()
	if (!isSearchEntityRefType(type)) {
		throw new McpCallerError(
			`Entity type must be one of: ${formatSearchEntityRefTypeList()}.`,
		)
	}
	if (!id) {
		throw new McpCallerError('Entity id must not be empty.')
	}
	if (hasSectionFragment && !section) {
		throw new McpCallerError(
			'Section fragment after "{id}:{type}#" must not be empty.',
		)
	}
	return section ? { id, type, section } : { id, type }
}

export function formatList(items: Array<string>) {
	if (items.length === 0) return 'none'
	return items.map((item) => `\`${item}\``).join(', ')
}

export function formatTtlMs(ttlMs: number | null) {
	if (ttlMs == null) return 'none'
	return `\`${ttlMs.toLocaleString()}\``
}
