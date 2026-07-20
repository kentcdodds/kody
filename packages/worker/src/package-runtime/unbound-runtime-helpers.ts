import { parseModuleSource } from '#worker/module-source.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { isKodyRuntimeModulePath } from './module-graph.ts'

/**
 * Optional `kody:runtime` exports intentionally stay falsy (`undefined` /
 * `null`) when the execution context does not bind them, so `if (storage)`
 * guards keep working. The cost is that guard-less access throws a bare
 * `Cannot read properties of undefined (reading 'sql')` / `X is not a
 * function` TypeError with no hint that the helper simply was not bound to
 * the call. This module matches such sandbox errors against the module
 * graph's actual `kody:runtime` imports so the execute pipeline can attach a
 * structured, actionable message (see `getExecutionErrorDetails` in
 * `#mcp/executor.ts`).
 */

export type UnboundRuntimeHelperAccess = {
	helperName: string
	reference: string
}

type RuntimeImportBinding =
	| { kind: 'named'; helperName: string; localName: string }
	| { kind: 'namespace'; localName: string }

const propertyReadErrorPattern =
	/Cannot read properties of (?:undefined|null) \(reading '([^']+)'\)/
const notAFunctionErrorPattern =
	/(?<![\w$.])([\w$]+(?:\.[\w$]+)*) is not a function/

const unboundRuntimeHelperMessagePattern =
	/The optional kody:runtime export "([\w$]+)" is not bound in this execution context/

export function createUnboundRuntimeHelperMessage(input: {
	originalMessage: string
	helperName: string
	reference: string
}) {
	const separator = /[.!?]\s*$/.test(input.originalMessage) ? ' ' : '. '
	// Attribution is a source-text heuristic (sandbox errors carry no stack),
	// so name the matching access without asserting it is the thrower.
	return (
		`${input.originalMessage}${separator}` +
		`The optional kody:runtime export "${input.helperName}" is not bound in this execution context, ` +
		`which likely caused \`${input.reference}\` to fail.`
	)
}

export function parseUnboundRuntimeHelperMessage(message: string) {
	return unboundRuntimeHelperMessagePattern.exec(message)?.[1] ?? null
}

/**
 * Matches a sandbox TypeError against the bundle's `kody:runtime` imports.
 * Returns the unbound optional helper whose guard-less access most plausibly
 * produced the error, or `null` when the error does not look like an
 * unbound-helper access (an ordinary user-code bug keeps its bare message).
 */
export function findUnboundRuntimeHelperAccess(input: {
	errorMessage: string
	modules: WorkerLoaderModules
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	if (input.unboundHelperNames.size === 0) return null
	const propertyName =
		propertyReadErrorPattern.exec(input.errorMessage)?.[1] ?? null
	const calledExpression = propertyName
		? null
		: (notAFunctionErrorPattern.exec(input.errorMessage)?.[1] ?? null)
	if (propertyName == null && calledExpression == null) return null
	for (const source of iterateModuleSourceTexts(input.modules)) {
		const bindings = collectRuntimeImportBindings(source)
		if (bindings.length === 0) continue
		const match = propertyName
			? findPropertyReadAccess({
					source,
					bindings,
					propertyName,
					unboundHelperNames: input.unboundHelperNames,
				})
			: findCalledHelperAccess({
					calledExpression: calledExpression ?? '',
					bindings,
					unboundHelperNames: input.unboundHelperNames,
				})
		if (match) return match
	}
	return null
}

function findPropertyReadAccess(input: {
	source: string
	bindings: Array<RuntimeImportBinding>
	propertyName: string
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	for (const binding of input.bindings) {
		if (binding.kind === 'named') {
			if (!input.unboundHelperNames.has(binding.helperName)) continue
			if (
				sourceContainsMemberAccess(input.source, [
					binding.localName,
					input.propertyName,
				])
			) {
				return {
					helperName: binding.helperName,
					reference: `${binding.helperName}.${input.propertyName}`,
				}
			}
			continue
		}
		for (const helperName of input.unboundHelperNames) {
			if (
				sourceContainsMemberAccess(input.source, [
					binding.localName,
					helperName,
					input.propertyName,
				])
			) {
				return {
					helperName,
					reference: `${helperName}.${input.propertyName}`,
				}
			}
		}
	}
	return null
}

function findCalledHelperAccess(input: {
	calledExpression: string
	bindings: Array<RuntimeImportBinding>
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	const parts = input.calledExpression.split('.')
	for (const binding of input.bindings) {
		if (binding.kind === 'named') {
			if (!input.unboundHelperNames.has(binding.helperName)) continue
			if (parts.length === 1 && parts[0] === binding.localName) {
				return {
					helperName: binding.helperName,
					reference: binding.helperName,
				}
			}
			continue
		}
		if (parts.length !== 2 || parts[0] !== binding.localName) continue
		const helperName = parts[1] ?? ''
		if (input.unboundHelperNames.has(helperName)) {
			return { helperName, reference: helperName }
		}
	}
	return null
}

function sourceContainsMemberAccess(source: string, memberPath: Array<string>) {
	// `?.` optional chaining short-circuits instead of throwing, so only a
	// plain `.` access can have produced the TypeError being matched.
	const pattern = new RegExp(
		`(?<![\\w$.])${memberPath.map(escapeRegExp).join('\\s*\\.\\s*')}(?![\\w$])`,
	)
	return pattern.test(source)
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectRuntimeImportBindings(
	source: string,
): Array<RuntimeImportBinding> {
	if (
		!source.includes('kody:runtime') &&
		!source.includes('runtime.js') &&
		!source.includes('__kodyOptionalRuntime')
	) {
		return []
	}
	let program: unknown
	try {
		program = parseModuleSource(source)
	} catch {
		return []
	}
	const bindings: Array<RuntimeImportBinding> = []
	for (const node of readProgramBody(program)) {
		collectInlinedRuntimeBindings(node, bindings)
		if (readNodeType(node) !== 'ImportDeclaration') continue
		if (readRecordValue(node, 'importKind') === 'type') continue
		const specifier = readImportSourceValue(node)
		if (specifier == null || !isRuntimeModuleSpecifier(specifier)) continue
		for (const importSpecifier of readImportSpecifiers(node)) {
			const localName = readIdentifierName(
				readRecordValue(importSpecifier, 'local'),
			)
			if (!localName) continue
			const specifierType = readNodeType(importSpecifier)
			if (specifierType === 'ImportSpecifier') {
				if (readRecordValue(importSpecifier, 'importKind') === 'type') continue
				const importedName =
					readIdentifierName(readRecordValue(importSpecifier, 'imported')) ??
					readImportedStringName(readRecordValue(importSpecifier, 'imported'))
				if (!importedName) continue
				bindings.push({
					kind: 'named',
					helperName: importedName,
					localName,
				})
				continue
			}
			if (
				specifierType === 'ImportDefaultSpecifier' ||
				specifierType === 'ImportNamespaceSpecifier'
			) {
				// The default export mirrors the named exports, so member access
				// through either binding behaves like a namespace access.
				bindings.push({ kind: 'namespace', localName })
			}
		}
	}
	return bindings
}

const inlinedRuntimeExportFactoryNames = new Set([
	'__kodyOptionalRuntimeObjectExport',
	'__kodyOptionalRuntimeFunctionExport',
])

/**
 * Bundlers can inline the virtual runtime module into the entry module, so
 * helpers appear as plain top-level declarations instead of imports:
 * `var storage = __kodyOptionalRuntimeObjectExport("storage", void 0);`.
 * Collect those as named bindings so inlined bundles match too.
 */
function collectInlinedRuntimeBindings(
	node: unknown,
	bindings: Array<RuntimeImportBinding>,
) {
	if (readNodeType(node) !== 'VariableDeclaration') return
	const declarations = readRecordValue(node, 'declarations')
	if (!Array.isArray(declarations)) return
	for (const declaration of declarations) {
		if (readNodeType(declaration) !== 'VariableDeclarator') continue
		const localName = readIdentifierName(readRecordValue(declaration, 'id'))
		if (!localName) continue
		const init = readRecordValue(declaration, 'init')
		if (readNodeType(init) !== 'CallExpression') continue
		const calleeName = readIdentifierName(readRecordValue(init, 'callee'))
		if (!calleeName || !inlinedRuntimeExportFactoryNames.has(calleeName)) {
			continue
		}
		const callArguments = readRecordValue(init, 'arguments')
		const helperName = Array.isArray(callArguments)
			? readImportedStringName(callArguments[0])
			: null
		if (!helperName) continue
		bindings.push({ kind: 'named', helperName, localName })
	}
}

function isRuntimeModuleSpecifier(specifier: string) {
	if (specifier === 'kody:runtime') return true
	// Bundled module graphs rewrite `kody:runtime` to a relative path of the
	// virtual runtime module (see `rewriteKodyImports` in `module-graph.ts`).
	return isKodyRuntimeModulePath(specifier.replace(/^(\.\.?\/)+/, ''))
}

function* iterateModuleSourceTexts(
	modules: WorkerLoaderModules,
): Generator<string> {
	for (const module of Object.values(modules)) {
		if (typeof module === 'string') {
			yield module
			continue
		}
		if (typeof module.js === 'string') yield module.js
		if (typeof module.cjs === 'string') yield module.cjs
	}
}

function readProgramBody(program: unknown): Array<unknown> {
	if (program == null || typeof program !== 'object') return []
	const programNode = readRecordValue(program, 'program') ?? program
	const body = readRecordValue(programNode, 'body')
	return Array.isArray(body) ? body : []
}

function readNodeType(node: unknown) {
	const type = readRecordValue(node, 'type')
	return typeof type === 'string' ? type : null
}

function readRecordValue(node: unknown, key: string): unknown {
	if (node == null || typeof node !== 'object') return undefined
	return (node as Record<string, unknown>)[key]
}

function readImportSourceValue(node: unknown) {
	const value = readRecordValue(readRecordValue(node, 'source'), 'value')
	return typeof value === 'string' ? value : null
}

function readImportSpecifiers(node: unknown): Array<unknown> {
	const specifiers = readRecordValue(node, 'specifiers')
	return Array.isArray(specifiers) ? specifiers : []
}

function readIdentifierName(node: unknown) {
	if (readNodeType(node) !== 'Identifier') return null
	const name = readRecordValue(node, 'name')
	return typeof name === 'string' ? name : null
}

function readImportedStringName(node: unknown) {
	const nodeType = readNodeType(node)
	if (nodeType !== 'StringLiteral' && nodeType !== 'Literal') return null
	const value = readRecordValue(node, 'value')
	return typeof value === 'string' ? value : null
}
