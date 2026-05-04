type XmlNode =
	| { kind: 'text'; value: string }
	| {
			kind: 'element'
			name: string
			attributes: Record<string, string>
			children: Array<XmlNode>
	  }

type ParseCursor = {
	source: string
	index: number
}

const xmlEntityMap: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
}

export function decodeXmlEntities(value: string) {
	return value.replace(
		/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi,
		(match, entity) => {
			const normalized = String(entity).toLowerCase()
			if (normalized.startsWith('#x')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
			}
			if (normalized.startsWith('#')) {
				return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
			}
			return xmlEntityMap[normalized] ?? match
		},
	)
}

function skipWhitespace(cursor: ParseCursor) {
	while (
		cursor.index < cursor.source.length &&
		/\s/.test(cursor.source[cursor.index] ?? '')
	) {
		cursor.index += 1
	}
}

function readName(cursor: ParseCursor) {
	const start = cursor.index
	while (cursor.index < cursor.source.length) {
		const char = cursor.source[cursor.index] ?? ''
		if (!/[\w:.-]/.test(char)) break
		cursor.index += 1
	}
	return cursor.source.slice(start, cursor.index)
}

function readAttributes(cursor: ParseCursor) {
	const attributes: Record<string, string> = {}
	while (cursor.index < cursor.source.length) {
		skipWhitespace(cursor)
		const next = cursor.source[cursor.index] ?? ''
		if (next === '/' || next === '>') return attributes
		const name = readName(cursor)
		if (!name) return attributes
		skipWhitespace(cursor)
		if (cursor.source[cursor.index] !== '=') {
			attributes[name] = ''
			continue
		}
		cursor.index += 1
		skipWhitespace(cursor)
		const quote = cursor.source[cursor.index]
		if (quote !== '"' && quote !== "'") {
			attributes[name] = ''
			continue
		}
		cursor.index += 1
		const valueStart = cursor.index
		while (
			cursor.index < cursor.source.length &&
			cursor.source[cursor.index] !== quote
		) {
			cursor.index += 1
		}
		attributes[name] = decodeXmlEntities(
			cursor.source.slice(valueStart, cursor.index),
		)
		if (cursor.source[cursor.index] === quote) cursor.index += 1
	}
	return attributes
}

function skipUntil(cursor: ParseCursor, terminator: string) {
	const at = cursor.source.indexOf(terminator, cursor.index)
	cursor.index = at === -1 ? cursor.source.length : at + terminator.length
}

function readNode(cursor: ParseCursor): XmlNode | null {
	if (cursor.index >= cursor.source.length) return null
	if (cursor.source[cursor.index] !== '<') {
		const start = cursor.index
		while (
			cursor.index < cursor.source.length &&
			cursor.source[cursor.index] !== '<'
		) {
			cursor.index += 1
		}
		return {
			kind: 'text',
			value: decodeXmlEntities(cursor.source.slice(start, cursor.index)),
		}
	}
	if (cursor.source.startsWith('<!--', cursor.index)) {
		skipUntil(cursor, '-->')
		return readNode(cursor)
	}
	if (cursor.source.startsWith('<![CDATA[', cursor.index)) {
		const start = cursor.index + '<![CDATA['.length
		const end = cursor.source.indexOf(']]>', start)
		const value =
			end === -1 ? cursor.source.slice(start) : cursor.source.slice(start, end)
		cursor.index = end === -1 ? cursor.source.length : end + ']]>'.length
		return { kind: 'text', value }
	}
	if (cursor.source.startsWith('<?', cursor.index)) {
		skipUntil(cursor, '?>')
		return readNode(cursor)
	}
	if (cursor.source.startsWith('<!', cursor.index)) {
		skipUntil(cursor, '>')
		return readNode(cursor)
	}
	if (cursor.source[cursor.index + 1] === '/') {
		return null
	}
	cursor.index += 1
	const name = readName(cursor)
	const attributes = readAttributes(cursor)
	if (cursor.source[cursor.index] === '/') {
		cursor.index += 1
		if (cursor.source[cursor.index] === '>') cursor.index += 1
		return {
			kind: 'element',
			name,
			attributes,
			children: [],
		}
	}
	if (cursor.source[cursor.index] === '>') cursor.index += 1
	const children: Array<XmlNode> = []
	while (cursor.index < cursor.source.length) {
		if (cursor.source.startsWith(`</${name}`, cursor.index)) {
			const afterName = cursor.source[cursor.index + 2 + name.length] ?? ''
			if (afterName === '>' || /\s/.test(afterName)) {
				skipUntil(cursor, '>')
				break
			}
		}
		if (cursor.source.startsWith('</', cursor.index)) {
			// Closing tag for an outer element. Leave it intact so the outer
			// parser can consume it and exit cleanly.
			break
		}
		const child = readNode(cursor)
		if (!child) break
		children.push(child)
	}
	return {
		kind: 'element',
		name,
		attributes,
		children,
	}
}

function parseXmlDocument(source: string): Array<XmlNode> {
	const cursor: ParseCursor = { source, index: 0 }
	const nodes: Array<XmlNode> = []
	while (cursor.index < cursor.source.length) {
		skipWhitespace(cursor)
		if (cursor.index >= cursor.source.length) break
		const node = readNode(cursor)
		if (!node) {
			cursor.index += 1
			continue
		}
		nodes.push(node)
	}
	return nodes
}

function nodeToValue(node: XmlNode): unknown {
	if (node.kind === 'text') {
		const trimmed = node.value.trim()
		return trimmed.length === 0 ? null : trimmed
	}
	const elementChildren = node.children.filter(
		(child) => child.kind === 'element',
	) as Array<Extract<XmlNode, { kind: 'element' }>>
	const textChildren = node.children
		.filter((child) => child.kind === 'text')
		.map((child) => (child as { kind: 'text'; value: string }).value.trim())
		.filter((value) => value.length > 0)
	const result: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(node.attributes)) {
		result[`@${name}`] = value
	}
	if (elementChildren.length === 0) {
		if (textChildren.length === 0) {
			return Object.keys(result).length === 0 ? null : result
		}
		const textValue = textChildren.join(' ')
		if (Object.keys(result).length === 0) return textValue
		result['#text'] = textValue
		return result
	}
	const grouped = new Map<string, Array<unknown>>()
	for (const child of elementChildren) {
		const value = nodeToValue(child)
		const list = grouped.get(child.name) ?? []
		list.push(value)
		grouped.set(child.name, list)
	}
	for (const [name, values] of grouped) {
		result[name] = values.length === 1 ? values[0] : values
	}
	if (textChildren.length > 0) {
		result['#text'] = textChildren.join(' ')
	}
	return result
}

export function parseAccessNetworksUnleashedXml(xml: string): unknown {
	const nodes = parseXmlDocument(xml)
	const elements = nodes.filter((node) => node.kind === 'element')
	if (elements.length === 0) return null
	if (elements.length === 1) {
		const root = elements[0] as Extract<XmlNode, { kind: 'element' }>
		return { [root.name]: nodeToValue(root) }
	}
	const grouped = new Map<string, Array<unknown>>()
	for (const node of elements) {
		const element = node as Extract<XmlNode, { kind: 'element' }>
		const value = nodeToValue(element)
		const list = grouped.get(element.name) ?? []
		list.push(value)
		grouped.set(element.name, list)
	}
	const result: Record<string, unknown> = {}
	for (const [name, values] of grouped) {
		result[name] = values.length === 1 ? values[0] : values
	}
	return result
}
