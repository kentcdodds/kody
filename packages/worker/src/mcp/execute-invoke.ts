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

import { executeInvokeFlagKey } from '#universal/feature-flags/registry.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'

export { executeInvokeFlagKey }

const invokeLocalName = 'action'

export const executeInvokeUnsupportedSpecifierMessage =
	'Unsupported execute invoke specifier. Use a kody:@scope/package/export (or @scope/package#export) package import, not a URL.'

export const executeInvokeMutualExclusionMessage =
	'execute accepts either code or invoke, not both. Pass a package export specifier in invoke, or a module string in code.'

export const executeInvokeMissingInputMessage =
	'execute requires code or invoke.'

export const executeInvokeFlagOffMessage =
	'execute invoke is an experiment. Opt in at /account/experiments. An operator must enable the execute-invoke flag for the experiments_opt_in audience.'

export const executeInvokeFieldDescription =
	'Package export specifier to run as a thin passthrough — the same module as import action from "kody:@scope/package/export" plus a default export that calls it with params. Accepts kody:@scope/package/export or @scope/package#export. Mutually exclusive with code. Vary args via params so the same graph is reused.'

export const executeToolDescriptionWithInvoke = `Run one ephemeral ESM module, or pass invoke with a kody:@scope/package/export specifier to mint the same thin passthrough. Discover the capability with search. Prefer invoke or a package import over rewriting helpers. Project large results before returning (e.g. { id, subject, snippet }). Same user and module graph reuse one isolate for the UTC day — vary args via params.

invoke: "kody:@scope/package/export"
// params: { ... }

import { kody } from 'kody:runtime'
export default async function main(params) {
  return await kody.capability_id(params)
}`

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
		throw new Error(executeInvokeUnsupportedSpecifierMessage)
	}
	if (looksLikeUrl(trimmed) && !trimmed.startsWith(packageSpecifierPrefix)) {
		throw new Error(executeInvokeUnsupportedSpecifierMessage)
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
			throw new Error(executeInvokeUnsupportedSpecifierMessage)
		}
		value = after ? `${before}/${after}` : before
	}

	if (value.startsWith('@')) {
		value = `kody:${value}`
	}

	if (!value.startsWith(packageSpecifierPrefix)) {
		throw new Error(executeInvokeUnsupportedSpecifierMessage)
	}

	try {
		const parsed = parseKodyPackageSpecifier(value)
		return buildPackageImportSpecifier(parsed.packageName, parsed.exportName)
	} catch {
		throw new Error(executeInvokeUnsupportedSpecifierMessage)
	}
}

/**
 * Canonical thin passthrough. Classifies as `thin_single_export` and matches
 * the default-export execute snippet search already teaches.
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

export function resolveExecuteModuleSource(input: {
	code?: string
	invoke?: string
	invokeEnabled: boolean
}): string {
	const code = input.code?.trim() ? input.code : undefined
	const invoke = input.invoke?.trim() ? input.invoke : undefined

	if (invoke && !input.invokeEnabled) {
		throw new Error(executeInvokeFlagOffMessage)
	}
	if (code && invoke) {
		throw new Error(executeInvokeMutualExclusionMessage)
	}
	if (invoke) {
		return resolveExecuteInvokeCode(invoke)
	}
	if (code) {
		return code
	}
	if (input.invokeEnabled) {
		throw new Error(executeInvokeMissingInputMessage)
	}
	throw new Error(executeInvokeMissingInputMessage)
}
