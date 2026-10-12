/**
 * Reads every credential placeholder out of a package's published modules,
 * with where each one is placed on a request, plus the package's declared
 * `kody.credentials` slots. Unlike codemod 0010, a placeholder that matches a
 * declared slot still counts: rescans use these counts to certify that the
 * old placeholder lane is gone.
 *
 * A placeholder bound to a variable is followed to each place the variable is
 * used, so `const key = '{{secret:x}}'` then `headers: { 'x-api-key': key }`
 * counts as a header. The binding itself is recorded as `binding`.
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
 * Where a request a placeholder fills is sent, read from a literal fetch URL:
 * a login or token exchange path, any other path, or not known statically.
 */
export type CredentialEndpoint = 'login' | 'other' | 'unknown'

/**
 * Why a placeholder that is not on a request shape sits where it does. Keys
 * and callee names are package identifiers, never credential names or values.
 */
export type CredentialOtherContext =
	/** A property of an object passed to a call or constructor (SDK options). */
	| 'sdk-option'
	/** A property of an object that is not passed anywhere directly. */
	| 'object'
	/** Passed straight to a function. */
	| 'argument'
	| 'return'
	| 'assignment'
	| 'array'
	| 'default-param'
	| 'comparison'
	/** Bound to a variable that is never read. */
	| 'unused-binding'
	/** A piece of a template whose other parts are computed. */
	| 'template-computed'
	/** In a URL host, which the gateway never fills. */
	| 'url-host'
	/** A module that did not parse, read as plain text. */
	| 'unparsed'
	| 'other'

/**
 * Header formats, query params, and identifiers are kept only in the safe
 * shapes a credential's `inject` can take or as plain identifiers; anything
 * else is counted by type without its text.
 */
export type CredentialPlacement =
	| { type: 'header'; name: string; format: string }
	| { type: 'query'; param: string }
	| { type: 'header-custom' }
	| { type: 'basic' }
	| { type: 'path' }
	/** The whole URL, or the URL up to its path, comes from the placeholder. */
	| { type: 'url' }
	| { type: 'body'; field: string | null; endpoint: CredentialEndpoint }
	/** Key material for a signature (HMAC, JWT, `crypto.subtle.sign`). */
	| { type: 'signing' }
	/** Bound to a variable; each read is recorded as its own reference. */
	| { type: 'binding' }
	| {
			type: 'other'
			context: CredentialOtherContext
			key: string | null
			callee: string | null
	  }

export type CredentialPlacementType = CredentialPlacement['type']

export const credentialPlacementTypes = [
	'header',
	'query',
	'header-custom',
	'basic',
	'path',
	'url',
	'body',
	'signing',
	'binding',
	'other',
] as const satisfies ReadonlyArray<CredentialPlacementType>

export const credentialOtherContexts = [
	'sdk-option',
	'object',
	'argument',
	'return',
	'assignment',
	'array',
	'default-param',
	'comparison',
	'unused-binding',
	'template-computed',
	'url-host',
	'unparsed',
	'other',
] as const satisfies ReadonlyArray<CredentialOtherContext>

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
	/** Where each `{{secret/provider:ref}}` vault placeholder sits. */
	vaultPlacements: Array<CredentialPlacement>
	/** `secretJwtSign` calls: signatures made with a saved secret by name. */
	jwtSignCalls: number
	slots: Array<CredentialSlotDeclaration>
	/** Modules that did not parse and were read as plain text. */
	unparsedModules: number
}

const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/
/** `{value}` alone or after one auth scheme word, such as `Bearer {value}`. */
const headerFormatPattern = /^(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?\{value\}$/
const queryParamBeforePattern = /[?&]([A-Za-z0-9._-]{1,64})=$/
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/
/** Path words of a login, session, or token exchange endpoint. */
const loginPathPattern =
	/(?:^|[/_.-])(?:login|log-in|signin|sign-in|sign_in|session|sessions|auth|authenticate|authorize|token|tokens|oauth2?)(?:$|[/_.?-])/i

/**
 * Calls whose arguments are signing key material. `encode` and `from` are
 * deliberately absent: they only count inside one of these.
 */
const signingCallees = new Set([
	'importKey',
	'createHmac',
	'hmac',
	'HmacSHA1',
	'HmacSHA256',
	'HmacSHA512',
	'sign',
	'signJwt',
	'jwtSign',
	'SignJWT',
	'createSigner',
	'createSign',
	'setSigningKey',
])

const transparentExpressionTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
])

const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
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
		vaultPlacements: [],
		jwtSignCalls: 0,
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
			recordPlaceholders(
				input.files[path]!,
				() => otherPlacement('unparsed'),
				scan,
			)
		}
	}
	return scan
}

function otherPlacement(
	context: CredentialOtherContext,
	key: string | null = null,
	callee: string | null = null,
): CredentialPlacement {
	return { type: 'other', context, key, callee }
}

function recordPlaceholders(
	text: string,
	placementOf: (match: PlaceholderMatch) => CredentialPlacement,
	scan: PackageCredentialScan,
) {
	for (const match of findPlaceholderMatches(text)) {
		scan.placeholders[match.kind] += 1
		if (match.kind === 'vault') {
			scan.vaultPlacements.push(placementOf(match))
			continue
		}
		const nameKind =
			match.kind === 'secret' || match.kind === 'secret-basic'
				? 'secret'
				: match.kind === 'integration-token'
					? 'integration'
					: null
		if (!nameKind) continue
		const placement = withoutCredentialNames(placementOf(match), match.names)
		for (const name of match.names) {
			scan.references.push({ nameKind, name, scope: match.scope, placement })
		}
	}
}

/** A key or callee that spells a credential name is dropped, not stored. */
function withoutCredentialNames(
	placement: CredentialPlacement,
	names: ReadonlyArray<string>,
): CredentialPlacement {
	const lowered = new Set(names.map((name) => name.toLowerCase()))
	const keep = (value: string | null) =>
		value != null && lowered.has(value.toLowerCase()) ? null : value
	switch (placement.type) {
		case 'body':
			return { ...placement, field: keep(placement.field) }
		case 'other':
			return {
				...placement,
				key: keep(placement.key),
				callee: keep(placement.callee),
			}
		default:
			return placement
	}
}

type Binding = { text: string; scope: AstNode }

/**
 * Variables bound to a string that holds a placeholder: the module's
 * constants (top-level and imported) plus `const`/`let` declarations inside
 * functions. Shadowing inside a scope is not tracked.
 */
function collectBindings(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
) {
	const bindings = new Map<string, Array<Binding>>()
	const add = (name: string, binding: Binding) => {
		const list = bindings.get(name) ?? []
		list.push(binding)
		bindings.set(name, list)
	}
	for (const [name, text] of constants) {
		if (findPlaceholderMatches(text).length > 0)
			add(name, { text, scope: parsed })
	}
	walkAst(parsed, (node, ancestors) => {
		if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') {
			return
		}
		const scope = enclosingScope(ancestors)
		if (scope === parsed) return
		const name = getNodeName(node.id)
		const text = resolveStringExpression(node.init, constants)
		if (!name || text == null || findPlaceholderMatches(text).length === 0) {
			return
		}
		add(name, { text, scope })
	})
	return bindings
}

function enclosingScope(ancestors: ReadonlyArray<AstNode>) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (functionTypes.has(ancestor.type)) return ancestor
	}
	return ancestors[0]!
}

function bindingInScope(
	bindings: ReadonlyMap<string, Array<Binding>>,
	name: string | null,
	ancestors: ReadonlyArray<AstNode>,
) {
	if (!name) return null
	const candidates = bindings.get(name)
	if (!candidates) return null
	const inScope = new Set(ancestors)
	// The innermost scope wins, as it does at runtime.
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const found = candidates.find(
			(binding) => binding.scope === ancestors[index],
		)
		if (found && inScope.has(found.scope)) return found
	}
	return null
}

/** Whether an identifier node reads a variable, not names a key or member. */
function isVariableRead(node: AstNode, ancestors: ReadonlyArray<AstNode>) {
	const parent = ancestors.at(-1)
	if (!parent) return false
	switch (parent.type) {
		case 'VariableDeclarator':
			return parent.init === node
		case 'MemberExpression':
		case 'OptionalMemberExpression':
			return parent.object === node || parent.computed === true
		case 'ObjectProperty':
			return parent.value === node
		case 'ClassProperty':
		case 'ClassPrivateProperty':
			return parent.value === node
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
		case 'ExportSpecifier':
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
		case 'TSPropertySignature':
		case 'TSTypeReference':
		case 'TSQualifiedName':
			return false
		default:
			return !functionTypes.has(parent.type) || parent.body === node
	}
}

function scanParsedModule(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	scan: PackageCredentialScan,
) {
	const bindings = collectBindings(parsed, constants)
	const readCount = new Map<Binding, number>()
	walkAst(parsed, (node, ancestors) => {
		if (node.type !== 'Identifier' || !isVariableRead(node, ancestors)) return
		const binding = bindingInScope(bindings, getNodeName(node), ancestors)
		if (binding) readCount.set(binding, (readCount.get(binding) ?? 0) + 1)
	})
	const exportedNames = new Set<string>()
	for (const statement of parsed.program?.body ?? []) {
		if (statement.type !== 'ExportNamedDeclaration') continue
		for (const declarator of statement.declaration?.declarations ?? []) {
			const name = getNodeName(declarator.id)
			if (name) exportedNames.add(name)
		}
		for (const specifier of statement.specifiers ?? []) {
			const name = getNodeName(specifier.local)
			if (name) exportedNames.add(name)
		}
	}
	const constantsIn = (ancestors: ReadonlyArray<AstNode>) => {
		const inScope = new Map(constants)
		for (const [name] of bindings) {
			const binding = bindingInScope(bindings, name, ancestors)
			if (binding) inScope.set(name, binding.text)
		}
		return inScope
	}
	const resolvedPieces = new WeakSet<AstNode>()
	walkAst(parsed, (node, ancestors) => {
		if (resolvedPieces.has(node)) return
		if (
			node.type === 'CallExpression' ||
			node.type === 'OptionalCallExpression'
		) {
			if (getCalleeName(node.callee) === 'secretJwtSign') scan.jwtSignCalls += 1
			return
		}
		const placementFor = (text: string) => (match: PlaceholderMatch) =>
			classifyPlacement(text, match, node, ancestors, {
				constants: constantsIn(ancestors),
				bindingReads: (declarator) => {
					const name = getNodeName(declarator.id)
					const binding = bindingInScope(bindings, name, [
						...ancestors,
						declarator,
					])
					if (name && exportedNames.has(name) && binding?.scope === parsed) {
						return 1
					}
					return binding ? (readCount.get(binding) ?? 0) : 0
				},
			})
		if (isCompositeString(node)) {
			const resolved = resolveStringExpression(node, constantsIn(ancestors))
			if (resolved != null) {
				walkAst(node, (piece) => resolvedPieces.add(piece))
				recordPlaceholders(resolved, placementFor(resolved), scan)
				return
			}
		}
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value == null) return
				recordPlaceholders(value, placementFor(value), scan)
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
							: otherPlacement('template-computed'),
					scan,
				)
				return
			}
			case 'Identifier': {
				if (!isVariableRead(node, ancestors)) return
				const binding = bindingInScope(bindings, getNodeName(node), ancestors)
				if (!binding) return
				recordPlaceholders(binding.text, placementFor(binding.text), scan)
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

function safeIdentifier(value: string | null) {
	return value != null && identifierPattern.test(value) ? value : null
}

type ClassifyContext = {
	constants: ReadonlyMap<string, string>
	/** How many times the variable a declarator binds is read. */
	bindingReads: (declarator: AstNode) => number
}

function classifyPlacement(
	text: string,
	match: PlaceholderMatch,
	node: AstNode,
	ancestors: ReadonlyArray<AstNode>,
	context: ClassifyContext,
): CredentialPlacement {
	if (match.kind === 'secret-basic') return { type: 'basic' }
	const parent = parentOf(ancestors)
	if (
		parent?.node.type === 'VariableDeclarator' &&
		parent.node.id?.type === 'Identifier' &&
		node !== parent.node.id
	) {
		return context.bindingReads(parent.node) > 0
			? { type: 'binding' }
			: otherPlacement('unused-binding')
	}
	if (isSigningKey(ancestors)) return { type: 'signing' }
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
	const call =
		parent &&
		(parent.node.type === 'CallExpression' ||
			parent.node.type === 'OptionalCallExpression' ||
			parent.node.type === 'NewExpression')
			? parent.node
			: null
	const argumentIndex = call
		? (call.arguments ?? []).indexOf(ancestors[parent!.index + 1] ?? node)
		: -1
	if (call && call.type !== 'NewExpression' && argumentIndex === 1) {
		const placement = setterPlacement(call, text, match)
		if (placement) return placement
	}
	const bodyIndex = ancestors.findIndex(
		(ancestor) => propertyKey(ancestor) === 'body',
	)
	if (bodyIndex !== -1) {
		return {
			type: 'body',
			field: safeIdentifier(nearestPropertyKey(ancestors, bodyIndex + 1)),
			endpoint: requestEndpoint(ancestors.slice(0, bodyIndex), context),
		}
	}
	if (call && argumentIndex === 0 && isUrlTaker(call) && match.start === 0) {
		return { type: 'url' }
	}
	if (/^https?:\/\//i.test(text)) return urlPlacement(text, match)
	if (match.start === 0 && /^[/?]/.test(text.slice(match.end))) {
		return { type: 'url' }
	}
	return otherContext(ancestors, node, call, argumentIndex)
}

function isSigningKey(ancestors: ReadonlyArray<AstNode>) {
	return ancestors.some(
		(ancestor) =>
			(ancestor.type === 'CallExpression' ||
				ancestor.type === 'OptionalCallExpression' ||
				ancestor.type === 'NewExpression') &&
			signingCallees.has(getCalleeName(ancestor.callee) ?? ''),
	)
}

/** `fetch(url)`, `new URL(url)`, `new Request(url)`, and `x.fetch(url)`. */
function isUrlTaker(call: AstNode) {
	const name = getCalleeName(call.callee)
	return name === 'fetch' || name === 'URL' || name === 'Request'
}

/** The key of the innermost object property at or below `from`. */
function nearestPropertyKey(ancestors: ReadonlyArray<AstNode>, from: number) {
	for (let index = ancestors.length - 1; index >= from; index -= 1) {
		const key = propertyKey(ancestors[index]!)
		if (key != null) return key
	}
	return null
}

/** The path of the enclosing `fetch` call's literal URL, by shape. */
function requestEndpoint(
	ancestors: ReadonlyArray<AstNode>,
	context: ClassifyContext,
): CredentialEndpoint {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (
			(ancestor.type === 'CallExpression' ||
				ancestor.type === 'OptionalCallExpression') &&
			getCalleeName(ancestor.callee) === 'fetch'
		) {
			const url = resolveStringExpression(
				ancestor.arguments?.[0],
				context.constants,
			)
			if (url == null) return 'unknown'
			const path = url.replace(/^[a-z]+:\/\/[^/]*/i, '')
			return loginPathPattern.test(path) ? 'login' : 'other'
		}
	}
	return 'unknown'
}

function otherContext(
	ancestors: ReadonlyArray<AstNode>,
	node: AstNode,
	call: AstNode | null,
	argumentIndex: number,
): CredentialPlacement {
	const parent = parentOf(ancestors)
	if (!parent) return otherPlacement('other')
	const calleeOf = (target: AstNode) =>
		safeIdentifier(getCalleeName(target.callee))
	if (call && argumentIndex !== -1) {
		return otherPlacement('argument', null, calleeOf(call))
	}
	switch (parent.node.type) {
		case 'ObjectProperty': {
			const key = safeIdentifier(propertyKey(parent.node))
			const object = parentOf(ancestors, parent.index)
			const holder = object ? parentOf(ancestors, object.index) : null
			if (
				holder &&
				(holder.node.type === 'CallExpression' ||
					holder.node.type === 'OptionalCallExpression' ||
					holder.node.type === 'NewExpression')
			) {
				return otherPlacement('sdk-option', key, calleeOf(holder.node))
			}
			return otherPlacement('object', key)
		}
		case 'ReturnStatement':
			return otherPlacement('return')
		case 'ArrowFunctionExpression':
			return parent.node.body === (ancestors[parent.index + 1] ?? node)
				? otherPlacement('return')
				: otherPlacement('default-param')
		case 'AssignmentExpression': {
			const left = parent.node.left
			const key =
				left?.type === 'MemberExpression' && left.computed !== true
					? safeIdentifier(getNodeName(left.property))
					: null
			return otherPlacement('assignment', key)
		}
		case 'AssignmentPattern':
			return otherPlacement('default-param')
		case 'ArrayExpression':
			return otherPlacement('array')
		case 'TemplateLiteral':
			return otherPlacement('template-computed')
		case 'BinaryExpression':
			return otherPlacement(
				parent.node.operator === '+' ? 'template-computed' : 'comparison',
			)
		case 'SwitchCase':
			return otherPlacement('comparison')
		default:
			return otherPlacement('other')
	}
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
			: otherPlacement('other')
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
	if (!/^[a-z]+:\/\/[^/?#]*\//i.test(before) && !before.includes('?')) {
		return otherPlacement('url-host')
	}
	const queryStart = before.indexOf('?')
	if (queryStart === -1) {
		return before.includes('#') ? otherPlacement('other') : { type: 'path' }
	}
	const param = queryParamBeforePattern.exec(before)?.[1]
	const next = text[match.end]
	if (param && (next === undefined || next === '&' || next === '#')) {
		return { type: 'query', param }
	}
	return otherPlacement('other')
}
