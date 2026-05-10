import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
} from './package-import-resolution.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

export type StaticKodyPackageImport = {
	filePath: string
	specifier: string
	packageName: string
	exportName: string
}

function getProgramBody(parsed: unknown): Array<ModuleAstNode> {
	const root = parsed as {
		program?: { body?: unknown }
		body?: unknown
	}
	const body = root.program?.body ?? root.body
	return Array.isArray(body) ? (body as Array<ModuleAstNode>) : []
}

function getSourceValue(node: ModuleAstNode) {
	const source = (node as { source?: unknown }).source
	if (!source || typeof source !== 'object') return null
	const value = (source as { value?: unknown }).value
	return typeof value === 'string' ? value.trim() : null
}

function isTypeOnlyImport(node: ModuleAstNode) {
	if ((node as { importKind?: unknown }).importKind === 'type') {
		return true
	}
	const specifiers = (node as { specifiers?: unknown }).specifiers
	if (!Array.isArray(specifiers) || specifiers.length === 0) {
		return false
	}
	return specifiers.every(
		(specifier) =>
			specifier &&
			typeof specifier === 'object' &&
			(specifier as { importKind?: unknown }).importKind === 'type',
	)
}

function isTypeOnlyExport(node: ModuleAstNode) {
	if ((node as { exportKind?: unknown }).exportKind === 'type') {
		return true
	}
	const specifiers = (node as { specifiers?: unknown }).specifiers
	if (!Array.isArray(specifiers) || specifiers.length === 0) {
		return false
	}
	return specifiers.every(
		(specifier) =>
			specifier &&
			typeof specifier === 'object' &&
			(specifier as { exportKind?: unknown }).exportKind === 'type',
	)
}

function collectStaticKodyPackageImportsFromSource(input: {
	filePath: string
	source: string
}): Array<StaticKodyPackageImport> {
	let parsed: unknown
	try {
		parsed = parseModuleSource(input.source)
	} catch {
		return []
	}
	const imports: Array<StaticKodyPackageImport> = []
	for (const node of getProgramBody(parsed)) {
		if (node.type === 'ImportDeclaration' && isTypeOnlyImport(node)) {
			continue
		}
		if (
			(node.type === 'ExportNamedDeclaration' ||
				node.type === 'ExportAllDeclaration') &&
			isTypeOnlyExport(node)
		) {
			continue
		}
		if (
			node.type !== 'ImportDeclaration' &&
			node.type !== 'ExportNamedDeclaration' &&
			node.type !== 'ExportAllDeclaration'
		) {
			continue
		}
		const specifier = getSourceValue(node)
		if (!specifier?.startsWith(packageSpecifierPrefix)) continue
		const parsedSpecifier = parseKodyPackageSpecifier(specifier)
		imports.push({
			filePath: input.filePath,
			specifier,
			packageName: parsedSpecifier.packageName,
			exportName: parsedSpecifier.exportName,
		})
	}
	return imports
}

export function collectStaticKodyPackageImportsFromFiles(
	files: Record<string, string>,
): Array<StaticKodyPackageImport> {
	return Object.entries(files)
		.flatMap(([filePath, source]) =>
			collectStaticKodyPackageImportsFromSource({
				filePath,
				source,
			}),
		)
		.sort(
			(left, right) =>
				left.packageName.localeCompare(right.packageName) ||
				left.exportName.localeCompare(right.exportName) ||
				left.filePath.localeCompare(right.filePath),
		)
}
