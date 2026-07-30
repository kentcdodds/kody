import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	collectDeprecatedInvocationUsage,
	type DeprecatedInvocationUsage,
} from '#worker/package-runtime/deprecated-invocation-usage.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const staticFirstInvocationCodemodId = '0002-static-first-invocation'

const invokeCheckedDetectMessage =
	'Calls deprecated `packages.invokeChecked`; rewrites mechanically to `packages.invoke` (same call shape and behavior — the runtime aliases them). Optionally, a human may later prefer a static `kody:@scope/pkg/export` import when the target package is known at write time.'

const checkDetectMessage =
	'Calls deprecated `packages.check`; `packages.invoke` already contract-checks before invoking, so restructure the call site manually (no mechanical rewrite preserves the contract return value).'

const dynamicImportDetectMessage =
	'Uses a literal dynamic `import("kody:@...")`; migrate manually — `packages.invoke` when the target is data, or a static import (declared in `package.json#kody.dependencies`) when the target is known at write time. Namespace semantics differ, so no mechanical rewrite is safe.'

const manualParseFailureMessage =
	'File references the deprecated dynamic invocation surface but could not be parsed; migrate to `packages.invoke` / static imports manually.'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

type AstNode = ModuleAstNode & {
	name?: unknown
	start?: number
	end?: number
	computed?: boolean
	object?: AstNode
	property?: AstNode
}

function isTypeDeclarationFilePath(path: string) {
	return (
		path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')
	)
}

function parseProgram(source: string): AstNode | null {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}

/**
 * Textual net for the parse-failure path: `collectDeprecatedInvocationUsage`
 * returns nothing for files it cannot parse, so unparseable files that still
 * mention the deprecated surface must be caught here and surfaced as
 * `needsManual` instead of silently scanning clean.
 */
function referencesDeprecatedSurface(source: string) {
	return (
		source.includes('invokeChecked') ||
		/packages\s*\??\.\s*check\b/.test(source) ||
		(source.includes('kody:@') && source.includes('import('))
	)
}

function collectUnparseableDeprecatedFiles(
	files: Record<string, string>,
): Array<string> {
	const paths: Array<string> = []
	for (const [path, source] of Object.entries(files)) {
		if (!scannableModuleFilePattern.test(path)) continue
		if (isTypeDeclarationFilePath(path)) continue
		if (!referencesDeprecatedSurface(source)) continue
		if (parseProgram(source) == null) {
			paths.push(path)
		}
	}
	return paths.sort((left, right) => left.localeCompare(right))
}

/**
 * Positions of the `invokeChecked` property identifier in
 * `packages.invokeChecked` / `packages?.invokeChecked` member expressions.
 * Only exact `packages` identifier objects match — the same shape the runtime
 * exposes and the publish-check deprecation collector warns on.
 */
function collectInvokeCheckedPropertyRanges(
	program: AstNode,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		if (
			(typedNode.type === 'MemberExpression' ||
				typedNode.type === 'OptionalMemberExpression') &&
			typedNode.computed !== true &&
			typedNode.object?.type === 'Identifier' &&
			typedNode.object.name === 'packages' &&
			typedNode.property?.type === 'Identifier' &&
			typedNode.property.name === 'invokeChecked' &&
			typeof typedNode.property.start === 'number' &&
			typeof typedNode.property.end === 'number'
		) {
			ranges.push({
				start: typedNode.property.start,
				end: typedNode.property.end,
			})
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') {
				visit(value)
			}
		}
	}

	visit(program)
	return ranges.sort((left, right) => left.start - right.start)
}

function rewriteInvokeChecked(source: string): string | null {
	const program = parseProgram(source)
	if (!program) return null
	const ranges = collectInvokeCheckedPropertyRanges(program)
	if (ranges.length === 0) return source
	let rewritten = ''
	let cursor = 0
	for (const range of ranges) {
		rewritten += source.slice(cursor, range.start)
		rewritten += 'invoke'
		cursor = range.end
	}
	rewritten += source.slice(cursor)
	return rewritten
}

function findingMessageForUsage(usage: DeprecatedInvocationUsage): string {
	switch (usage.kind) {
		case 'packages.invokeChecked':
			return invokeCheckedDetectMessage
		case 'packages.check':
			return checkDetectMessage
		case 'dynamic-kody-import':
			return dynamicImportDetectMessage
		default: {
			const exhaustive: never = usage.kind
			void exhaustive
			throw new Error('Unhandled deprecated invocation usage kind.')
		}
	}
}

function detect(files: Record<string, string>): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> =
		collectDeprecatedInvocationUsage(files).map((usage) => ({
			path: usage.filePath,
			message: findingMessageForUsage(usage),
		}))
	for (const path of collectUnparseableDeprecatedFiles(files)) {
		findings.push({ path, message: manualParseFailureMessage })
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transform(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const usages = collectDeprecatedInvocationUsage(files)
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	const unparseablePaths = collectUnparseableDeprecatedFiles(files)
	for (const path of unparseablePaths) {
		needsManual.push({ path, message: manualParseFailureMessage })
	}
	const unparseablePathSet = new Set(unparseablePaths)
	const invokeCheckedPaths = new Set(
		usages
			.filter((usage) => usage.kind === 'packages.invokeChecked')
			.map((usage) => usage.filePath),
	)

	for (const usage of usages) {
		// `packages.check` return values and dynamic-import namespaces have no
		// mechanical one-to-one rewrite; report them instead of guessing.
		if (usage.kind !== 'packages.invokeChecked') {
			needsManual.push({
				path: usage.filePath,
				message: findingMessageForUsage(usage),
			})
		}
	}

	for (const path of [...invokeCheckedPaths].sort((left, right) =>
		left.localeCompare(right),
	)) {
		const source = nextFiles[path]
		if (typeof source !== 'string') continue
		const rewritten = rewriteInvokeChecked(source)
		if (rewritten == null) {
			needsManual.push({ path, message: manualParseFailureMessage })
			continue
		}
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
	}

	// Defensive verification over every rewrite candidate (not only changed
	// files): any detectable `packages.invokeChecked` member expression that
	// survives the rewrite pass needs a human.
	for (const path of [...invokeCheckedPaths].sort((left, right) =>
		left.localeCompare(right),
	)) {
		if (unparseablePathSet.has(path)) continue
		const source = nextFiles[path]
		if (!scannableModuleFilePattern.test(path)) continue
		if (isTypeDeclarationFilePath(path)) continue
		const remaining = collectDeprecatedInvocationUsage({
			[path]: source ?? '',
		}).filter((usage) => usage.kind === 'packages.invokeChecked')
		if (remaining.length > 0) {
			needsManual.push({
				path,
				message:
					'`packages.invokeChecked` member expressions remain after the rewrite; migrate manually.',
			})
		}
	}

	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Static-first invocation migration (narrow phase of the two-rule model):
 *
 * - `packages.invokeChecked(...)` is rewritten mechanically to
 *   `packages.invoke(...)` — identical input shape; invoke is always
 *   contract-checked, and key-less calls take the lean/ephemeral path.
 * - `packages.check(...)` and literal dynamic `import("kody:@...")` have no
 *   safe mechanical rewrite (return values / namespace semantics differ), so
 *   they surface as `needsManual` findings naming the replacement.
 */
export const staticFirstInvocationCodemod: PackageCodemod = {
	id: staticFirstInvocationCodemodId,
	description:
		'Rewrite deprecated packages.invokeChecked calls to packages.invoke and flag packages.check / literal dynamic import("kody:@...") usage for manual static-first migration.',
	detect,
	transform,
}
