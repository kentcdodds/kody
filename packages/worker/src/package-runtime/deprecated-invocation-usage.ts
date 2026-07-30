import { parseModuleSource } from '#worker/module-source.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

/**
 * Detection for the removed legacy dynamic invocation surface:
 * `packages.check`, `packages.invokeChecked`, and literal dynamic
 * `import("kody:@...")`. Publish checks fail on these (the runtime throws
 * teaching errors), and the `0002-static-first-invocation` package codemod
 * reuses the same collector so codemod findings stay in lockstep.
 */
export type DeprecatedInvocationUsageKind =
	| 'packages.check'
	| 'packages.invokeChecked'
	| 'dynamic-kody-import'

export type DeprecatedInvocationUsage = {
	filePath: string
	kind: DeprecatedInvocationUsageKind
}

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

function collectDeprecatedPackagesMemberKinds(
	source: string,
): Set<DeprecatedInvocationUsageKind> {
	const kinds = new Set<DeprecatedInvocationUsageKind>()
	let program: unknown
	try {
		program = parseModuleSource(source)
	} catch {
		return kinds
	}

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as {
			type?: string
			computed?: boolean
			object?: { type?: string; name?: unknown }
			property?: { type?: string; name?: unknown }
		}
		if (
			// Babel emits OptionalMemberExpression for `packages?.check`.
			(typedNode.type === 'MemberExpression' ||
				typedNode.type === 'OptionalMemberExpression') &&
			typedNode.computed !== true &&
			typedNode.object?.type === 'Identifier' &&
			typedNode.object.name === 'packages' &&
			typedNode.property?.type === 'Identifier'
		) {
			if (typedNode.property.name === 'check') {
				kinds.add('packages.check')
			} else if (typedNode.property.name === 'invokeChecked') {
				kinds.add('packages.invokeChecked')
			}
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') {
				visit(value)
			}
		}
	}

	visit(program)
	return kinds
}

function moduleHasLiteralDynamicKodyImport(source: string) {
	return collectLiteralImportNodes(source).some(
		(node) =>
			node.kind === 'dynamic' &&
			node.specifier.startsWith(packageSpecifierPrefix),
	)
}

export function collectDeprecatedInvocationUsage(
	sourceFiles: Record<string, string>,
): Array<DeprecatedInvocationUsage> {
	const usages: Array<DeprecatedInvocationUsage> = []
	for (const [filePath, source] of Object.entries(sourceFiles)) {
		if (!scannableModuleFilePattern.test(filePath)) continue
		if (isTypeDeclarationFilePath(filePath)) continue
		if (source.includes('packages')) {
			for (const kind of collectDeprecatedPackagesMemberKinds(source)) {
				usages.push({ filePath, kind })
			}
		}
		if (
			source.includes(packageSpecifierPrefix) &&
			moduleHasLiteralDynamicKodyImport(source)
		) {
			usages.push({ filePath, kind: 'dynamic-kody-import' })
		}
	}
	return usages.sort(
		(left, right) =>
			left.filePath.localeCompare(right.filePath) ||
			left.kind.localeCompare(right.kind),
	)
}

const removedUsageReplacements: Record<DeprecatedInvocationUsageKind, string> =
	{
		'packages.check':
			'packages.check was removed: packages.invoke always contract-checks before invoking, so call it directly',
		'packages.invokeChecked':
			'packages.invokeChecked was removed: use a static kody:@scope/pkg/export import when the target package is known at write time, or packages.invoke({ kodyId, exportName, params }) for dynamic targets',
		'dynamic-kody-import':
			'literal dynamic import("kody:@...") was removed: use a static import and declare it in package.json#kody.dependencies, or packages.invoke when the target is data',
	}

const maxReportedRemovedUsages = 5

export function formatRemovedInvocationUsageFailure(
	usages: Array<DeprecatedInvocationUsage>,
) {
	if (usages.length === 0) return null
	const shown = usages.slice(0, maxReportedRemovedUsages)
	const hiddenCount = usages.length - shown.length
	const details = shown
		.map(
			(usage) => `"${usage.filePath}": ${removedUsageReplacements[usage.kind]}`,
		)
		.join('; ')
	return `Package code uses the removed dynamic invocation surface: ${details}${
		hiddenCount > 0 ? ` (and ${hiddenCount} more)` : ''
	}. The 0002-static-first-invocation package codemod migrates invokeChecked call sites mechanically.`
}
