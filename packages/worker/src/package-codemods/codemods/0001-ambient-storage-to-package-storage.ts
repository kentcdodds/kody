import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import { collectAmbientStorageImportFiles } from '#worker/repo/checks.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const ambientStorageToPackageStorageCodemodId =
	'0001-ambient-storage-to-package-storage'

const ambientStorageDetectMessage =
	"Imports ambient `storage` from 'kody:runtime'; migrate to `packageStorage()`."

const manualAliasMessage =
	'Ambient `storage` is imported under an alias; migrate to `packageStorage()` manually.'

const manualUnusualMessage =
	"Ambient `storage` import from 'kody:runtime' uses a pattern this codemod will not rewrite; migrate to `packageStorage()` manually."

const packageStorageBindingStatement = 'const storage = packageStorage()'

type NamedImportSpecifier = {
	type: string
	importKind?: unknown
	imported?: { name?: unknown; value?: unknown }
	local?: { name?: unknown; value?: unknown }
	start?: number
	end?: number
}

type ImportDeclarationNode = ModuleAstNode & {
	importKind?: unknown
	source?: { value?: unknown }
	specifiers?: Array<NamedImportSpecifier>
	start?: number
	end?: number
}

function getNodeName(node: { name?: unknown; value?: unknown } | undefined) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

function getProgramBody(source: string): Array<ModuleAstNode> | null {
	let parsed: ModuleAstNode
	try {
		parsed = parseModuleSource(source) as unknown as ModuleAstNode
	} catch {
		return null
	}
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	return Array.isArray(body) ? body : null
}

function listRuntimeStorageImports(source: string) {
	const body = getProgramBody(source)
	if (!body) return null
	const imports: Array<{
		declaration: ImportDeclarationNode
		storageSpecifiers: Array<NamedImportSpecifier>
		hasPackageStorage: boolean
		hasUnusualSpecifiers: boolean
	}> = []
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		const declaration = node as ImportDeclarationNode
		if (declaration.importKind === 'type') continue
		if (declaration.source?.value !== 'kody:runtime') continue
		const specifiers = Array.isArray(declaration.specifiers)
			? declaration.specifiers
			: []
		const storageSpecifiers: Array<NamedImportSpecifier> = []
		let hasPackageStorage = false
		let hasUnusualSpecifiers = false
		for (const specifier of specifiers) {
			if (specifier.type === 'ImportDefaultSpecifier') {
				hasUnusualSpecifiers = true
				continue
			}
			if (specifier.type === 'ImportNamespaceSpecifier') {
				hasUnusualSpecifiers = true
				continue
			}
			if (specifier.type !== 'ImportSpecifier') continue
			if (specifier.importKind === 'type') continue
			const importedName = getNodeName(specifier.imported)
			const localName = getNodeName(specifier.local)
			if (importedName === 'packageStorage') {
				hasPackageStorage = true
				continue
			}
			if (importedName !== 'storage') {
				continue
			}
			if (localName !== 'storage') {
				hasUnusualSpecifiers = true
			}
			storageSpecifiers.push(specifier)
		}
		if (storageSpecifiers.length === 0) continue
		imports.push({
			declaration,
			storageSpecifiers,
			hasPackageStorage,
			hasUnusualSpecifiers,
		})
	}
	return { body, imports }
}

function hasExportReexportOfStorage(body: Array<ModuleAstNode>) {
	for (const node of body) {
		if (node.type !== 'ExportNamedDeclaration') continue
		const declaration = node as ModuleAstNode & {
			source?: { value?: unknown }
			specifiers?: Array<{
				type?: string
				local?: { name?: unknown; value?: unknown }
				exported?: { name?: unknown; value?: unknown }
			}>
		}
		if (declaration.source?.value !== 'kody:runtime') continue
		const specifiers = Array.isArray(declaration.specifiers)
			? declaration.specifiers
			: []
		for (const specifier of specifiers) {
			const localName = getNodeName(specifier.local)
			const exportedName = getNodeName(specifier.exported)
			if (localName === 'storage' || exportedName === 'storage') {
				return true
			}
		}
	}
	return false
}

function hasTopLevelStorageBindingBesidesImport(input: {
	body: Array<ModuleAstNode>
	importStarts: Set<number>
}) {
	for (const node of input.body) {
		if (
			node.type === 'ImportDeclaration' &&
			typeof node.start === 'number' &&
			input.importStarts.has(node.start)
		) {
			continue
		}
		if (node.type === 'VariableDeclaration') {
			const declarations = (node as { declarations?: Array<ModuleAstNode> })
				.declarations
			if (!Array.isArray(declarations)) continue
			for (const declarator of declarations) {
				const id = (declarator as { id?: ModuleAstNode }).id
				if (
					id?.type === 'Identifier' &&
					getNodeName(id as never) === 'storage'
				) {
					return true
				}
			}
		}
		if (
			node.type === 'FunctionDeclaration' ||
			node.type === 'ClassDeclaration'
		) {
			const id = (node as { id?: ModuleAstNode }).id
			if (id?.type === 'Identifier' && getNodeName(id as never) === 'storage') {
				return true
			}
		}
	}
	return false
}

function removeSpecifierFromImportText(input: {
	source: string
	declaration: ImportDeclarationNode
	specifier: NamedImportSpecifier
}) {
	const declarationStart = input.declaration.start
	const declarationEnd = input.declaration.end
	const specifierStart = input.specifier.start
	const specifierEnd = input.specifier.end
	if (
		declarationStart == null ||
		declarationEnd == null ||
		specifierStart == null ||
		specifierEnd == null
	) {
		return null
	}
	const declarationText = input.source.slice(declarationStart, declarationEnd)
	const relativeStart = specifierStart - declarationStart
	const relativeEnd = specifierEnd - declarationStart
	const before = declarationText.slice(0, relativeStart)
	const after = declarationText.slice(relativeEnd)
	const beforeTrimmed = before.replace(/\s*,\s*$/, '')
	const afterTrimmed = after.replace(/^\s*,\s*/, (match) =>
		beforeTrimmed.trimEnd().endsWith('{') ? match.replace(',', '') : match,
	)
	let nextDeclaration = `${beforeTrimmed}${afterTrimmed}`
	nextDeclaration = nextDeclaration.replace(/\{\s*,/, '{')
	nextDeclaration = nextDeclaration.replace(/,\s*\}/, ' }')
	nextDeclaration = nextDeclaration.replace(/\{\s+\}/, '{}')
	return (
		input.source.slice(0, declarationStart) +
		nextDeclaration +
		input.source.slice(declarationEnd)
	)
}

function replaceSpecifierNameInImportText(input: {
	source: string
	specifier: NamedImportSpecifier
	nextName: string
}) {
	const start = input.specifier.start
	const end = input.specifier.end
	if (start == null || end == null) return null
	return input.source.slice(0, start) + input.nextName + input.source.slice(end)
}

function findImportBlockInsertOffset(body: Array<ModuleAstNode>) {
	let lastImportEnd: number | null = null
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') {
			if (lastImportEnd != null) break
			continue
		}
		if (typeof node.end === 'number') {
			lastImportEnd = node.end
		}
	}
	return lastImportEnd
}

function transformSourceFile(source: string): {
	content: string
	changed: boolean
	needsManual: string | null
} {
	const analyzed = listRuntimeStorageImports(source)
	if (!analyzed || analyzed.imports.length === 0) {
		return { content: source, changed: false, needsManual: null }
	}
	if (analyzed.imports.length > 1) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const target = analyzed.imports[0]!
	if (target.hasUnusualSpecifiers) {
		return {
			content: source,
			changed: false,
			needsManual: manualAliasMessage,
		}
	}
	if (target.storageSpecifiers.length !== 1) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	if (hasExportReexportOfStorage(analyzed.body)) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const storageSpecifier = target.storageSpecifiers[0]!
	if (
		typeof target.declaration.start !== 'number' ||
		typeof storageSpecifier.start !== 'number' ||
		typeof storageSpecifier.end !== 'number'
	) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const importStarts = new Set<number>(
		analyzed.imports
			.map((entry) => entry.declaration.start)
			.filter((start): start is number => typeof start === 'number'),
	)
	if (
		hasTopLevelStorageBindingBesidesImport({
			body: analyzed.body,
			importStarts,
		})
	) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}

	let nextSource: string | null
	if (target.hasPackageStorage) {
		nextSource = removeSpecifierFromImportText({
			source,
			declaration: target.declaration,
			specifier: storageSpecifier,
		})
	} else {
		nextSource = replaceSpecifierNameInImportText({
			source,
			specifier: storageSpecifier,
			nextName: 'packageStorage',
		})
	}
	if (nextSource == null) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}

	const reanalyzed = getProgramBody(nextSource)
	if (!reanalyzed) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const insertAt = findImportBlockInsertOffset(reanalyzed)
	if (insertAt == null) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const alreadyBound =
		nextSource.includes(packageStorageBindingStatement) ||
		/\bconst\s+storage\s*=\s*packageStorage\s*\(/.test(nextSource)
	if (!alreadyBound) {
		const before = nextSource.slice(0, insertAt)
		const after = nextSource.slice(insertAt)
		const prefix = before.endsWith('\n') ? '' : '\n'
		const suffix = after.startsWith('\n') ? '' : '\n'
		nextSource = `${before}${prefix}${packageStorageBindingStatement}${suffix}${after}`
	}
	if (nextSource === source) {
		return { content: source, changed: false, needsManual: null }
	}
	return { content: nextSource, changed: true, needsManual: null }
}

function detectAmbientStorage(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	return collectAmbientStorageImportFiles(files).map((path) => ({
		path,
		message: ambientStorageDetectMessage,
	}))
}

function transformAmbientStorage(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	const ambientPaths = collectAmbientStorageImportFiles(files)
	for (const path of ambientPaths) {
		const source = files[path]
		if (typeof source !== 'string') continue
		const result = transformSourceFile(source)
		if (result.needsManual) {
			needsManual.push({ path, message: result.needsManual })
			continue
		}
		if (!result.changed) continue
		nextFiles[path] = result.content
		changedPaths.push(path)
	}
	changedPaths.sort((left, right) => left.localeCompare(right))
	needsManual.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

export const ambientStorageToPackageStorageCodemod = {
	id: ambientStorageToPackageStorageCodemodId,
	description:
		"Replace ambient `storage` imports from 'kody:runtime' with `packageStorage()`.",
	detect: detectAmbientStorage,
	transform: transformAmbientStorage,
} satisfies PackageCodemod
