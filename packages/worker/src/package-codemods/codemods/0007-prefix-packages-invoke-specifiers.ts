import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const prefixPackagesInvokeSpecifiersCodemodId =
	'0007-prefix-packages-invoke-specifiers'

const rewriteMessage =
	'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.'
const manualMessage =
	'A packages.invoke specifier is dynamic or ambiguous; add the kody: prefix manually.'
const parseFailureMessage =
	'File references packages.invoke but could not be parsed; add kody: prefixes manually.'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const markdownFilePattern = /\.mdx?$/
const packagesInvokeDetectorPattern = /packages\s*\??\.\s*invoke\b/
const markdownModuleLanguages = new Set([
	'cjs',
	'cts',
	'javascript',
	'js',
	'jsx',
	'mjs',
	'mts',
	'ts',
	'tsx',
	'typescript',
])

type AstNode = ModuleAstNode & {
	start?: number
	end?: number
	computed?: boolean
	name?: unknown
	value?: unknown
	callee?: AstNode
	object?: AstNode
	property?: AstNode
	arguments?: Array<AstNode>
	expressions?: Array<AstNode>
}

type SourceRewrite = {
	start: number
	end: number
	replacement: string
}

type FileClassification = {
	path: string
	rewrites: Array<SourceRewrite>
	needsManual: string | null
}

type MarkdownCodeFence = {
	start: number
	end: number
	contentStart: number
	contentEnd: number
	language: string
}

function patternBindsPackages(pattern: unknown): boolean {
	if (!pattern || typeof pattern !== 'object') return false
	const node = pattern as Record<string, unknown>
	switch (node['type']) {
		case 'Identifier':
			return node['name'] === 'packages'
		case 'AssignmentPattern':
			return patternBindsPackages(node['left'])
		case 'RestElement':
			return patternBindsPackages(node['argument'])
		case 'ArrayPattern':
			return (
				Array.isArray(node['elements']) &&
				node['elements'].some(patternBindsPackages)
			)
		case 'ObjectPattern':
			return (
				Array.isArray(node['properties']) &&
				node['properties'].some((property) => {
					if (!property || typeof property !== 'object') return false
					const propertyNode = property as Record<string, unknown>
					return propertyNode['type'] === 'RestElement'
						? patternBindsPackages(propertyNode['argument'])
						: patternBindsPackages(propertyNode['value'])
				})
			)
		case 'TSParameterProperty':
			return patternBindsPackages(node['parameter'])
		default:
			return false
	}
}

function classifyPackagesBindings(program: AstNode) {
	let canonicalImportCount = 0
	let hasOtherBinding = false

	function visit(value: unknown): void {
		if (!value || typeof value !== 'object') return
		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		if (!('type' in value)) return
		const node = value as Record<string, unknown>
		const type = node['type']

		if (type === 'ImportDeclaration') {
			const source = node['source']
			const sourceValue =
				source && typeof source === 'object'
					? (source as Record<string, unknown>)['value']
					: null
			const specifiers = node['specifiers']
			if (Array.isArray(specifiers)) {
				for (const specifier of specifiers) {
					if (!specifier || typeof specifier !== 'object') continue
					const specifierNode = specifier as Record<string, unknown>
					if (!patternBindsPackages(specifierNode['local'])) continue
					const imported = specifierNode['imported']
					const importedName =
						imported && typeof imported === 'object'
							? ((imported as Record<string, unknown>)['name'] ??
								(imported as Record<string, unknown>)['value'])
							: null
					if (
						sourceValue === 'kody:runtime' &&
						specifierNode['type'] === 'ImportSpecifier' &&
						importedName === 'packages'
					) {
						canonicalImportCount += 1
					} else {
						hasOtherBinding = true
					}
				}
			}
		} else {
			const params = node['params']
			if (Array.isArray(params) && params.some(patternBindsPackages)) {
				hasOtherBinding = true
			}
			if (
				(type === 'VariableDeclarator' ||
					type === 'CatchClause' ||
					type === 'FunctionExpression' ||
					type === 'ClassExpression' ||
					(typeof type === 'string' &&
						(type.endsWith('Declaration') || type.startsWith('TS')))) &&
				(patternBindsPackages(node['id']) ||
					patternBindsPackages(node['param']))
			) {
				hasOtherBinding = true
			}
		}

		for (const child of Object.values(node)) {
			if (child != null && typeof child === 'object') visit(child)
		}
	}

	visit(program)
	return {
		canRewrite:
			!hasOtherBinding &&
			(canonicalImportCount === 0 || canonicalImportCount === 1),
	}
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

function isPackagesInvokeCall(node: AstNode) {
	if (
		node.type !== 'CallExpression' &&
		node.type !== 'OptionalCallExpression'
	) {
		return false
	}
	const callee = node.callee
	return (
		(callee?.type === 'MemberExpression' ||
			callee?.type === 'OptionalMemberExpression') &&
		callee.computed !== true &&
		callee.object?.type === 'Identifier' &&
		callee.object.name === 'packages' &&
		callee.property?.type === 'Identifier' &&
		callee.property.name === 'invoke'
	)
}

function classifyLiteralSpecifier(
	source: string,
	node: AstNode,
): SourceRewrite | 'unchanged' | 'manual' {
	if (typeof node.start !== 'number' || typeof node.end !== 'number') {
		return 'manual'
	}
	const literalSource = source.slice(node.start, node.end)
	const quote = literalSource[0]
	if (
		(quote !== "'" && quote !== '"' && quote !== '`') ||
		literalSource.at(-1) !== quote
	) {
		return 'manual'
	}
	if (
		quote === '`' &&
		(node.expressions?.length !== 0 || literalSource.includes('${'))
	) {
		return 'manual'
	}
	const rawValue = literalSource.slice(1, -1)
	const value =
		typeof node.value === 'string'
			? node.value
			: quote === '`'
				? rawValue
				: null
	if (value == null) return 'manual'
	if (rawValue.includes('\\') || (quote !== '`' && rawValue !== value)) {
		return 'manual'
	}
	const trimmedValue = value.trim()
	if (trimmedValue.startsWith(packageSpecifierPrefix)) return 'unchanged'
	if (!trimmedValue.startsWith('@')) return 'manual'
	let canonicalValue: string
	try {
		const prefixedSpecifier = `kody:${trimmedValue}`
		const parsed = parseKodyPackageSpecifier(prefixedSpecifier)
		const pathSegments = prefixedSpecifier
			.slice(packageSpecifierPrefix.length)
			.split('/')
		const hasExplicitExport = pathSegments
			.slice(2)
			.some((segment) => segment.trim())
		canonicalValue = `${packageSpecifierPrefix}${parsed.packageName.slice(1)}${
			hasExplicitExport ? `/${parsed.exportName}` : ''
		}`
	} catch {
		return 'manual'
	}
	return {
		start: node.start,
		end: node.end,
		replacement: `${quote}${canonicalValue}${quote}`,
	}
}

function classifyModuleSource(input: {
	path: string
	source: string
	offset?: number
}): FileClassification | null {
	if (!packagesInvokeDetectorPattern.test(input.source)) return null
	const program = parseProgram(input.source)
	if (!program) {
		return {
			path: input.path,
			rewrites: [],
			needsManual: parseFailureMessage,
		}
	}
	const rewrites: Array<SourceRewrite> = []
	let hasManual = false
	const bindingClassification = classifyPackagesBindings(program)

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		if (isPackagesInvokeCall(typedNode)) {
			const firstArg = typedNode.arguments?.[0]
			if (firstArg?.type !== 'ObjectExpression') {
				if (
					firstArg?.type === 'StringLiteral' ||
					firstArg?.type === 'Literal' ||
					firstArg?.type === 'TemplateLiteral'
				) {
					const result = classifyLiteralSpecifier(input.source, firstArg)
					if (result !== 'unchanged') {
						if (!bindingClassification.canRewrite || result === 'manual') {
							hasManual = true
						} else {
							rewrites.push(result)
						}
					}
				} else {
					hasManual = true
				}
			}
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') visit(value)
		}
	}

	visit(program)
	if (rewrites.length === 0 && !hasManual) return null
	const offset = input.offset ?? 0
	return {
		path: input.path,
		rewrites: rewrites.map((rewrite) => ({
			...rewrite,
			start: rewrite.start + offset,
			end: rewrite.end + offset,
		})),
		needsManual: hasManual ? manualMessage : null,
	}
}

function listMarkdownCodeFences(source: string): Array<MarkdownCodeFence> {
	const fences: Array<MarkdownCodeFence> = []
	const openerPattern = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n/gm
	let opener: RegExpExecArray | null
	while ((opener = openerPattern.exec(source))) {
		const marker = opener[1]
		const markerCharacter = marker?.[0]
		if (!marker || !markerCharacter) continue
		const contentStart = opener.index + opener[0].length
		const closingPattern = new RegExp(
			`^(?: {0,3})${markerCharacter === '`' ? '`' : '~'}{${marker.length},}[ \\t]*\\r?$`,
			'gm',
		)
		closingPattern.lastIndex = contentStart
		const closing = closingPattern.exec(source)
		if (!closing) break
		fences.push({
			start: opener.index,
			end: closing.index + closing[0].length,
			contentStart,
			contentEnd: closing.index,
			language:
				(opener[2] ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '',
		})
		openerPattern.lastIndex = closing.index + closing[0].length
	}
	return fences
}

function listMarkdownHtmlRanges(
	source: string,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []
	const commentPattern = /<!--[\s\S]*?(?:-->|$)/g
	for (const match of source.matchAll(commentPattern)) {
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}
	const blockPattern = /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
	for (const match of source.matchAll(blockPattern)) {
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}
	return ranges
}

function rangeOverlaps(
	range: { start: number; end: number },
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	return ranges.some(
		(candidate) => range.start < candidate.end && candidate.start < range.end,
	)
}

function sourceOutsideRangesHasPackagesInvoke(
	source: string,
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	const sorted = [...ranges].sort((left, right) => left.start - right.start)
	let cursor = 0
	for (const range of sorted) {
		if (packagesInvokeDetectorPattern.test(source.slice(cursor, range.start))) {
			return true
		}
		cursor = Math.max(cursor, range.end)
	}
	return packagesInvokeDetectorPattern.test(source.slice(cursor))
}

function classifyMarkdownFile(input: {
	path: string
	source: string
}): FileClassification | null {
	if (!packagesInvokeDetectorPattern.test(input.source)) return null
	const fences = listMarkdownCodeFences(input.source)
	const htmlRanges = listMarkdownHtmlRanges(input.source)
	const coveredRanges: Array<{ start: number; end: number }> = [
		...fences.map((fence) => ({ start: fence.start, end: fence.end })),
		...htmlRanges,
	]
	const rewrites: Array<SourceRewrite> = []
	let needsManual: string | null = null
	if (
		htmlRanges.some((range) =>
			packagesInvokeDetectorPattern.test(
				input.source.slice(range.start, range.end),
			),
		)
	) {
		needsManual = manualMessage
	}
	for (const fence of fences) {
		if (rangeOverlaps(fence, htmlRanges)) continue
		const content = input.source.slice(fence.contentStart, fence.contentEnd)
		if (!markdownModuleLanguages.has(fence.language)) {
			if (packagesInvokeDetectorPattern.test(content)) {
				needsManual ??= manualMessage
			}
			continue
		}
		const classification = classifyModuleSource({
			path: input.path,
			source: content,
			offset: fence.contentStart,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		needsManual ??= classification.needsManual
	}

	// Only single, unescaped backtick spans are mechanically unambiguous.
	// Multi-backtick spans and escaped delimiters remain unchanged and fall
	// through to the fixed manual finding below.
	const inlineCodePattern = /(?<![\\`])`(?!`)([^`\n]+)`(?!`)/g
	let inlineCode: RegExpExecArray | null
	while ((inlineCode = inlineCodePattern.exec(input.source))) {
		const range = {
			start: inlineCode.index,
			end: inlineCode.index + inlineCode[0].length,
		}
		if (rangeOverlaps(range, coveredRanges)) continue
		coveredRanges.push(range)
		const classification = classifyModuleSource({
			path: input.path,
			source: inlineCode[1] ?? '',
			offset: inlineCode.index + 1,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		needsManual ??= classification.needsManual
	}
	if (sourceOutsideRangesHasPackagesInvoke(input.source, coveredRanges)) {
		needsManual ??= manualMessage
	}
	if (rewrites.length === 0 && needsManual == null) return null
	return { path: input.path, rewrites, needsManual }
}

function classifyFile(input: {
	path: string
	source: string
}): FileClassification | null {
	if (markdownFilePattern.test(input.path)) return classifyMarkdownFile(input)
	if (
		!scannableModuleFilePattern.test(input.path) ||
		isTypeDeclarationFilePath(input.path)
	) {
		return null
	}
	return classifyModuleSource(input)
}

function classifyFiles(
	files: Record<string, string>,
): Array<FileClassification> {
	return Object.entries(files)
		.flatMap(([path, source]) => {
			const classification = classifyFile({ path, source })
			return classification ? [classification] : []
		})
		.sort((left, right) => left.path.localeCompare(right.path))
}

function detect(files: Record<string, string>): Array<PackageCodemodFinding> {
	return classifyFiles(files).map((classification) => ({
		path: classification.path,
		message: classification.needsManual ?? rewriteMessage,
	}))
}

function applyRewrites(source: string, rewrites: Array<SourceRewrite>) {
	let nextSource = source
	for (const rewrite of [...rewrites].sort(
		(left, right) => right.start - left.start,
	)) {
		nextSource =
			nextSource.slice(0, rewrite.start) +
			rewrite.replacement +
			nextSource.slice(rewrite.end)
	}
	return nextSource
}

function transform(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const nextFiles = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const classification of classifyFiles(files)) {
		const source = files[classification.path]
		if (typeof source !== 'string') continue
		const nextSource = applyRewrites(source, classification.rewrites)
		if (nextSource !== source) {
			nextFiles[classification.path] = nextSource
			changedPaths.push(classification.path)
		}
		if (classification.needsManual) {
			needsManual.push({
				path: classification.path,
				message: classification.needsManual,
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

/** Add the preferred `kody:` prefix without changing call options or exports. */
export const prefixPackagesInvokeSpecifiersCodemod = {
	id: prefixPackagesInvokeSpecifiersCodemodId,
	description:
		'Rewrite literal prefixless packages.invoke specifiers to the preferred kody:@owner/package[/export] form; flag dynamic or unparseable calls for manual review.',
	detect,
	transform,
} satisfies PackageCodemod
