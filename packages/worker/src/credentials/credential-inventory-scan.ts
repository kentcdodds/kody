/**
 * Reads every credential placeholder out of a package's published modules,
 * with where each one is placed on a request, plus the package's declared
 * `kody.credentials` slots. Unlike codemod 0010, a placeholder that matches a
 * declared slot still counts: rescans use these counts to certify that the
 * old placeholder lane is gone.
 */
import {
	type PackageCredentialKind,
	type PackageCredentialSlot,
} from '#worker/package-registry/types.ts'
import {
	type AstNode,
	createModuleConstantsReader,
	findPlaceholderMatches,
	getCalleeName,
	getNodeName,
	parseModule,
	type PlaceholderMatch,
	type PlaceholderMatchKind,
	resolveStringExpression,
	scannableModuleFilePattern,
	templateElementText,
	testFilePattern,
	walkAst,
} from './module-placeholder-scan.ts'

/**
 * Where a placeholder sits on a request. Header formats and query params are
 * kept only in the safe shapes a credential's `inject` can take; anything
 * else is counted by type without its text.
 */
export type CredentialPlacement =
	| { type: 'header'; name: string; format: string }
	| { type: 'query'; param: string }
	| { type: 'header-custom' }
	| { type: 'basic' }
	| { type: 'path' }
	| { type: 'body' }
	| { type: 'other' }

export type CredentialPlacementType = CredentialPlacement['type']

export type CredentialReference = {
	nameKind: 'secret' | 'integration'
	name: string
	/** Literal `|scope=` suffix, or null. */
	scope: string | null
	placement: CredentialPlacement
}

export type CredentialSlotDeclaration = {
	name: string
	kind: PackageCredentialKind
	provider: string
}

export type PackageCredentialScan = {
	/** Every placeholder occurrence, by kind, slot or no slot. */
	placeholders: Record<PlaceholderMatchKind, number>
	references: Array<CredentialReference>
	slots: Array<CredentialSlotDeclaration>
	/** Modules that did not parse and were read as plain text. */
	unparsedModules: number
}

const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/
/** `{value}` alone or after one auth scheme word, such as `Bearer {value}`. */
const headerFormatPattern = /^(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?\{value\}$/
const queryParamBeforePattern = /[?&]([A-Za-z0-9._-]{1,64})=$/

const transparentExpressionTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
])

export function emptyPlaceholderCounts(): Record<PlaceholderMatchKind, number> {
	return {
		secret: 0,
		'secret-basic': 0,
		'integration-token': 0,
		vault: 0,
		computed: 0,
	}
}

export function scanPackageCredentials(input: {
	files: Record<string, string>
	slots: Record<string, PackageCredentialSlot> | undefined
}): PackageCredentialScan {
	const scan: PackageCredentialScan = {
		placeholders: emptyPlaceholderCounts(),
		references: [],
		slots: Object.entries(input.slots ?? {}).map(([name, slot]) => ({
			name,
			kind: slot.kind,
			provider: slot.provider,
		})),
		unparsedModules: 0,
	}
	const modulePaths = Object.keys(input.files)
		.filter(
			(path) =>
				scannableModuleFilePattern.test(path) && !testFilePattern.test(path),
		)
		.sort()
	const parsedModules = new Map(
		modulePaths.map((path) => [path, parseModule(input.files[path]!)]),
	)
	const readConstants = createModuleConstantsReader(parsedModules)
	for (const path of modulePaths) {
		const parsed = parsedModules.get(path)
		if (parsed) {
			scanParsedModule(parsed, readConstants(path), scan)
		} else {
			scan.unparsedModules += 1
			recordPlaceholders(input.files[path]!, () => ({ type: 'other' }), scan)
		}
	}
	return scan
}

function recordPlaceholders(
	text: string,
	placementOf: (match: PlaceholderMatch) => CredentialPlacement,
	scan: PackageCredentialScan,
) {
	for (const match of findPlaceholderMatches(text)) {
		scan.placeholders[match.kind] += 1
		const nameKind =
			match.kind === 'secret' || match.kind === 'secret-basic'
				? 'secret'
				: match.kind === 'integration-token'
					? 'integration'
					: null
		if (!nameKind) continue
		const placement = placementOf(match)
		for (const name of match.names) {
			scan.references.push({ nameKind, name, scope: match.scope, placement })
		}
	}
}

function scanParsedModule(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	scan: PackageCredentialScan,
) {
	const resolvedPieces = new WeakSet<AstNode>()
	walkAst(parsed, (node, ancestors) => {
		if (resolvedPieces.has(node)) return
		if (isCompositeString(node)) {
			const resolved = resolveStringExpression(node, constants)
			if (resolved != null) {
				walkAst(node, (piece) => resolvedPieces.add(piece))
				recordPlaceholders(
					resolved,
					(match) => classifyPlacement(resolved, match, node, ancestors),
					scan,
				)
				return
			}
		}
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value == null) return
				recordPlaceholders(
					value,
					(match) => classifyPlacement(value, match, node, ancestors),
					scan,
				)
				return
			}
			case 'TemplateElement': {
				// A piece of a template that does not resolve to one string: the
				// placeholder sits in a computed value, so only its kind is known.
				recordPlaceholders(
					templateElementText(node),
					(match) =>
						match.kind === 'secret-basic'
							? { type: 'basic' }
							: { type: 'other' },
					scan,
				)
				return
			}
			default:
				return
		}
	})
}

function isCompositeString(node: AstNode) {
	if (node.type === 'TemplateLiteral') return true
	return node.type === 'BinaryExpression' && node.operator === '+'
}

/** The nearest ancestor, skipping parentheses and type assertions. */
function parentOf(ancestors: ReadonlyArray<AstNode>, from = ancestors.length) {
	for (let index = from - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (!transparentExpressionTypes.has(ancestor.type)) {
			return { node: ancestor, index }
		}
	}
	return null
}

function propertyKey(node: AstNode) {
	if (node.type !== 'ObjectProperty' || node.computed === true) return null
	return getNodeName(node.key)
}

function classifyPlacement(
	text: string,
	match: PlaceholderMatch,
	node: AstNode,
	ancestors: ReadonlyArray<AstNode>,
): CredentialPlacement {
	if (match.kind === 'secret-basic') return { type: 'basic' }
	const parent = parentOf(ancestors)
	if (parent?.node.type === 'ObjectProperty') {
		const key = propertyKey(parent.node)
		const object = parentOf(ancestors, parent.index)
		const holder = object ? parentOf(ancestors, object.index) : null
		if (
			key != null &&
			object?.node.type === 'ObjectExpression' &&
			holder &&
			isHeadersHolder(holder.node, object.node)
		) {
			return headerPlacement(key, text, match)
		}
	}
	if (
		parent &&
		(parent.node.type === 'CallExpression' ||
			parent.node.type === 'OptionalCallExpression') &&
		parent.node.arguments?.[1] === node
	) {
		const placement = setterPlacement(parent.node, text, match)
		if (placement) return placement
	}
	if (/^https?:\/\//i.test(text)) return urlPlacement(text, match)
	if (ancestors.some((ancestor) => propertyKey(ancestor) === 'body')) {
		return { type: 'body' }
	}
	return { type: 'other' }
}

function isHeadersHolder(holder: AstNode, object: AstNode) {
	if (holder.type === 'ObjectProperty') {
		return propertyKey(holder) === 'headers' && holder.value === object
	}
	return (
		holder.type === 'NewExpression' &&
		getNodeName(holder.callee) === 'Headers' &&
		holder.arguments?.[0] === object
	)
}

/** `headers.set('X-Api-Key', …)` and `url.searchParams.set('key', …)`. */
function setterPlacement(
	call: AstNode,
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement | null {
	const method = getCalleeName(call.callee)
	if (method !== 'set' && method !== 'append') return null
	const target = call.callee?.object
	const key = resolveStringExpression(call.arguments?.[0], new Map())
	if (key == null) return null
	const targetName =
		target?.type === 'MemberExpression' ||
		target?.type === 'OptionalMemberExpression'
			? getNodeName(target.property)
			: getNodeName(target)
	if (targetName === 'searchParams') {
		return isWholeValue(text, match) && /^[A-Za-z0-9._-]{1,64}$/.test(key)
			? { type: 'query', param: key }
			: { type: 'other' }
	}
	if (targetName && /headers/i.test(targetName)) {
		return headerPlacement(key, text, match)
	}
	return null
}

function isWholeValue(text: string, match: PlaceholderMatch) {
	return match.start === 0 && match.end === text.length
}

function headerPlacement(
	name: string,
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement {
	const format = `${text.slice(0, match.start)}{value}${text.slice(match.end)}`
	if (!headerNamePattern.test(name) || !headerFormatPattern.test(format)) {
		return { type: 'header-custom' }
	}
	return { type: 'header', name: name.toLowerCase(), format }
}

function urlPlacement(
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement {
	const before = text.slice(0, match.start)
	const queryStart = before.indexOf('?')
	if (queryStart === -1) {
		return before.includes('#') ? { type: 'other' } : { type: 'path' }
	}
	const param = queryParamBeforePattern.exec(before)?.[1]
	const next = text[match.end]
	if (param && (next === undefined || next === '&' || next === '#')) {
		return { type: 'query', param }
	}
	return { type: 'other' }
}
