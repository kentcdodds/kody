import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
} from './module-graph-path-basics.ts'

/**
 * Local package-graph rewrite for secret-bearing ambient `fetch`.
 *
 * Cloud execute expands `{{secret:…}}` placeholders at the fetch gateway.
 * Local workerd ambient fetch does not. Package-graph therefore:
 * 1. Replaces quoted resolvable secret placeholder literals with
 *    `__kodySecretRef(...)` so package modules no longer embed a string that
 *    ambient fetch could send to a third party.
 * 2. Shadows `fetch` with a CapabilityProxy `gatewayFetch` hop so expansion
 *    still happens on origin (same `expandSecretPlaceholders` as cloud).
 */

const secretPlaceholderLiteralPattern =
	/(['"])\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?\}\}\1/g

const gatewayFetchBindingMarker = '__kodyCreatePackageBoundGatewayFetch'
const unboundGatewayFetchMarker = '__kodyGatewayFetch as fetch'
const secretRefMarker = '__kodySecretRef('

export function moduleSourceHasSecretPlaceholderLiterals(source: string) {
	secretPlaceholderLiteralPattern.lastIndex = 0
	return secretPlaceholderLiteralPattern.test(source)
}

/**
 * Replace quoted `{{secret:name}}` / `{{secret:name|scope=…}}` literals with
 * `__kodySecretRef(...)` calls. Leaves other placeholder families alone
 * (secret-basic / integration-token / provider) — those still expand when
 * fetch is rebound to gatewayFetch.
 */
export function rewriteLocalExecuteSecretPlaceholderLiterals(source: string) {
	secretPlaceholderLiteralPattern.lastIndex = 0
	const next = source.replace(
		secretPlaceholderLiteralPattern,
		(_match, _quote: string, name: string, scope: string | undefined) =>
			`__kodySecretRef(${JSON.stringify(name)}, ${
				scope === 'package' || scope === 'session' || scope === 'user'
					? JSON.stringify(scope)
					: 'null'
			})`,
	)
	return {
		source: next,
		rewritten: next !== source,
	}
}

export function moduleSourceHasLocalExecuteGatewayFetchBinding(source: string) {
	return (
		source.includes(gatewayFetchBindingMarker) ||
		source.includes(unboundGatewayFetchMarker)
	)
}

/**
 * Shadow module-local `fetch` with a CapabilityProxy gateway hop. Safe to
 * call on modules that already bind fetch (no-op when the hop is present).
 * When placeholders were rewritten to `__kodySecretRef` but the binding was
 * already injected by the inlined-runtime rewrite, ensure `__kodySecretRef`
 * is imported.
 */
export function injectLocalExecuteGatewayFetchBinding(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
	packageId: string | null
}): { source: string; rewritten: boolean } {
	const needsSecretRef = input.source.includes(secretRefMarker)
	const hasFetchBinding = moduleSourceHasLocalExecuteGatewayFetchBinding(
		input.source,
	)
	const hasSecretRefImport = /\bimport\s*\{[^}]*\b__kodySecretRef\b/.test(
		input.source,
	)

	if (hasFetchBinding) {
		if (!needsSecretRef || hasSecretRefImport) {
			return { source: input.source, rewritten: false }
		}
		const relativeShim = createRelativeImportSpecifier(
			normalizeWorkspaceModulePath(input.modulePath),
			normalizeWorkspaceModulePath(input.primaryRuntimePath),
		)
		return {
			source: `import { __kodySecretRef } from ${JSON.stringify(relativeShim)};
${input.source}`,
			rewritten: true,
		}
	}

	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const shimLiteral = JSON.stringify(relativeShim)
	const preamble = input.packageId
		? needsSecretRef
			? `import { __kodyCreatePackageBoundGatewayFetch, __kodySecretRef } from ${shimLiteral};
const fetch = __kodyCreatePackageBoundGatewayFetch(${JSON.stringify(input.packageId)});
`
			: `import { __kodyCreatePackageBoundGatewayFetch } from ${shimLiteral};
const fetch = __kodyCreatePackageBoundGatewayFetch(${JSON.stringify(input.packageId)});
`
		: needsSecretRef
			? `import { __kodyGatewayFetch as fetch, __kodySecretRef } from ${shimLiteral};
`
			: `import { __kodyGatewayFetch as fetch } from ${shimLiteral};
`
	return {
		source: `${preamble}${input.source}`,
		rewritten: true,
	}
}

/**
 * Apply placeholder literal rewrite + gateway fetch binding for one
 * published package module returned by package-graph.
 */
export function rewriteLocalExecuteModuleForSecretAwareFetch(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
	packageId: string | null
}): { source: string; rewritten: boolean } {
	const placeholders = rewriteLocalExecuteSecretPlaceholderLiterals(
		input.source,
	)
	const withFetch = injectLocalExecuteGatewayFetchBinding({
		modulePath: input.modulePath,
		source: placeholders.source,
		primaryRuntimePath: input.primaryRuntimePath,
		packageId: input.packageId,
	})
	return {
		source: withFetch.source,
		rewritten: placeholders.rewritten || withFetch.rewritten,
	}
}
