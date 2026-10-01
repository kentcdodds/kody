/**
 * MCP execute `invoke` codegen shortcut.
 *
 * `invoke` is not a parallel runtime. It writes the same canonical thin
 * passthrough a careful agent writes for a package export (`thin_single_export`),
 * then the existing execute path bundles and evaluates that source. Same
 * LOADER id as the hand-written module.
 *
 * Prefer `invoke: "kody:@scope/package/export"` with varying args in `params`
 * so one isolate is reused for the UTC day.
 */

import { McpCallerError } from '#mcp/caller-error.ts'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import { executeInvokeFlagKey } from '#universal/feature-flags/registry.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'

export { executeInvokeFlagKey }

const invokeLocalName = 'action'

const executeInvokeUnsupportedSpecifierMessage =
	'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.'

export const executeInvokeMutualExclusionMessage =
	'execute accepts either code or invoke, not both.'

export const executeInvokeMissingInputMessage =
	'execute requires code or invoke.'

export const executeInvokeFlagOffMessage =
	'execute invoke is an experiment. Opt in at /account/experiments, then an operator enables execute-invoke for experiments_opt_in.'

export const executeInvokeFieldDescription =
	'Package export specifier (kody:@scope/package/export or @scope/package#export). Mutually exclusive with code. Same thin passthrough as a static kody:@ import plus default export(params). Vary args via params.'

export const executeToolDescriptionWithInvoke = `${executeToolDescription}

Or pass invoke: "kody:@scope/package/export" (mutually exclusive with code) to mint that same thin passthrough. Vary args via params.`

function looksLikeUrl(value: string) {
	return /:\/\//.test(value)
}

/**
 * Normalize an invoke specifier to the canonical `kody:@scope/package[/export]`
 * form used by static package imports. Hash is accepted as the export
 * separator (`@scope/package#export`).
 */
export function parseExecuteInvokeSpecifier(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) {
		throw new McpCallerError(executeInvokeUnsupportedSpecifierMessage)
	}
	if (looksLikeUrl(trimmed) && !trimmed.startsWith(packageSpecifierPrefix)) {
		throw new McpCallerError(executeInvokeUnsupportedSpecifierMessage)
	}

	let value = trimmed
	const hashIndex = value.indexOf('#')
	if (hashIndex >= 0) {
		const before = value.slice(0, hashIndex).trim()
		const after = value
			.slice(hashIndex + 1)
			.trim()
			.replace(/^\.\//, '')
		if (!before || value.includes('#', hashIndex + 1)) {
			throw new McpCallerError(executeInvokeUnsupportedSpecifierMessage)
		}
		value = after ? `${before}/${after}` : before
	}

	if (value.startsWith('@')) {
		value = `kody:${value}`
	}

	if (!value.startsWith(packageSpecifierPrefix)) {
		throw new McpCallerError(executeInvokeUnsupportedSpecifierMessage)
	}

	try {
		const parsed = parseKodyPackageSpecifier(value)
		return buildPackageImportSpecifier(parsed.packageName, parsed.exportName)
	} catch {
		throw new McpCallerError(executeInvokeUnsupportedSpecifierMessage)
	}
}

/**
 * Canonical thin passthrough. Classifies as `thin_single_export` and matches
 * the default-export execute snippet search already teaches. Named-only
 * package callables stay on `code`; invoke always default-imports the
 * package export module.
 */
export function buildExecuteInvokePassthroughSource(specifier: string): string {
	return `import ${invokeLocalName} from ${JSON.stringify(specifier)}

export default async function main(params) {
	return await ${invokeLocalName}(params)
}`
}

export function resolveExecuteInvokeCode(invoke: string): string {
	return buildExecuteInvokePassthroughSource(
		parseExecuteInvokeSpecifier(invoke),
	)
}

/**
 * How the execute module source was supplied. Persisted on run metadata so
 * Activity / `runList` can attribute invoke vs handwritten `code` without
 * re-classifying the body.
 */
export type ExecuteEntry = 'invoke' | 'code'

export type ResolvedExecuteModule = {
	code: string
	entry: ExecuteEntry
	/** Canonical `kody:@…` specifier when `entry` is `invoke`. */
	invoke?: string
}

/**
 * Run-metadata keys for execute attribution. Keep these stable: Activity and
 * `runList` read them as opaque metadata (forward-only; no backfill).
 */
export const executeEntryMetadataKey = 'entry'
export const executeInvokeMetadataKey = 'invoke'
export const executeWorkerIdMetadataKey = 'workerId'

export function buildExecuteAttributionMetadata(input: {
	entry: ExecuteEntry
	invoke?: string
}): Record<string, string> {
	return {
		[executeEntryMetadataKey]: input.entry,
		...(input.entry === 'invoke' && input.invoke
			? { [executeInvokeMetadataKey]: input.invoke }
			: {}),
	}
}

export function resolveExecuteModule(input: {
	code?: string
	invoke?: string
	invokeEnabled: boolean
}): ResolvedExecuteModule {
	const code = input.code?.trim() ? input.code : undefined
	const invoke = input.invoke?.trim() ? input.invoke : undefined

	if (invoke && !input.invokeEnabled) {
		throw new McpCallerError(executeInvokeFlagOffMessage)
	}
	if (code && invoke) {
		throw new McpCallerError(executeInvokeMutualExclusionMessage)
	}
	if (invoke) {
		const specifier = parseExecuteInvokeSpecifier(invoke)
		return {
			code: buildExecuteInvokePassthroughSource(specifier),
			entry: 'invoke',
			invoke: specifier,
		}
	}
	if (code) {
		return { code, entry: 'code' }
	}
	if (input.invokeEnabled) {
		throw new McpCallerError(executeInvokeMissingInputMessage)
	}
	throw new McpCallerError(executeInvokeMissingInputMessage)
}

export function resolveExecuteModuleSource(input: {
	code?: string
	invoke?: string
	invokeEnabled: boolean
}): string {
	return resolveExecuteModule(input).code
}
