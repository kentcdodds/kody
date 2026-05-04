export type UnleashedRecord = Record<string, unknown>

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

export function escapeXmlAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

export function normalizeMacAddress(value: string) {
	const cleaned = value
		.trim()
		.toLowerCase()
		.replace(/[^0-9a-f]/g, '')
	if (cleaned.length !== 12) {
		throw new Error(
			'@kentcdodds/unleashed-wifi: macAddress must be a valid 12-hex-digit MAC address.',
		)
	}
	const octets = cleaned.match(/.{2}/g)
	if (!octets) {
		throw new Error('@kentcdodds/unleashed-wifi: invalid MAC address.')
	}
	return octets.join(':')
}

function parseScalar(value: string): string | number | boolean | null {
	const trimmed = decodeXmlEntities(value.trim())
	if (!trimmed) return null
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed)
	if (/^(true|enabled|yes)$/i.test(trimmed)) return true
	if (/^(false|disabled|no)$/i.test(trimmed)) return false
	return trimmed
}

function parseAttributes(value: string): UnleashedRecord {
	const record: UnleashedRecord = {}
	const attributeRegex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs
	for (const match of value.matchAll(attributeRegex)) {
		const key = String(match[1] ?? '').trim()
		if (!key) continue
		record[key] = parseScalar(match[3] ?? '')
	}
	return record
}

export function extractElements(
	xml: string,
	tagName: string,
): Array<UnleashedRecord & { rawXml: string }> {
	const records: Array<UnleashedRecord & { rawXml: string }> = []
	const elementRegex = new RegExp(
		`<${tagName}(?=[\\s>/])(?<attributes>[^>]*)>(?<body>[\\s\\S]*?)<\\/${tagName}>|<${tagName}(?=[\\s>/])(?<selfClosingAttributes>[^>]*)\\/>`,
		'gi',
	)
	for (const match of xml.matchAll(elementRegex)) {
		const groups = match.groups ?? {}
		const attributes =
			groups['attributes'] ?? groups['selfClosingAttributes'] ?? ''
		const body = groups['body'] ?? ''
		const record = parseAttributes(attributes) as UnleashedRecord & {
			rawXml: string
		}
		record.rawXml = match[0]
		const childRegex = /<([:\w-]+)(?=[\s>/])[^>]*>([\s\S]*?)<\/\1>/g
		for (const childMatch of body.matchAll(childRegex)) {
			const key = String(childMatch[1] ?? '').trim()
			if (!key || key in record) continue
			const childBody = childMatch[2] ?? ''
			if (/<[a-zA-Z]/.test(childBody)) continue
			record[key] = parseScalar(childBody)
		}
		records.push(record)
	}
	return records
}

export function extractElementByAttribute(input: {
	xml: string
	tagName: string
	attributeName: string
	attributeValue: string
}) {
	const elementRegex = new RegExp(
		`<${input.tagName}(?=[\\s>/])(?<attributes>[^>]*)>(?<body>[\\s\\S]*?)<\\/${input.tagName}>|<${input.tagName}(?=[\\s>/])(?<selfClosingAttributes>[^>]*)\\/>`,
		'gi',
	)
	for (const match of input.xml.matchAll(elementRegex)) {
		const attributes =
			match.groups?.['attributes'] ??
			match.groups?.['selfClosingAttributes'] ??
			''
		const record = parseAttributes(attributes)
		if (String(record[input.attributeName] ?? '') === input.attributeValue) {
			return match[0]
		}
	}
	return null
}

export function getAttributeValue(elementXml: string, name: string) {
	const attrPattern = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i')
	const match = attrPattern.exec(elementXml)
	return match ? decodeXmlEntities(match[2] ?? '') : null
}

function escapeReplacementString(value: string) {
	return value.replace(/\$/g, '$$$$')
}

export function setOrAddAttribute(
	elementXml: string,
	name: string,
	value: string,
) {
	const escapedValue = escapeXmlAttribute(value)
	const replacementSafeValue = escapeReplacementString(escapedValue)
	const attrPattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, 'i')
	if (attrPattern.test(elementXml)) {
		return elementXml.replace(attrPattern, `$1'${replacementSafeValue}'`)
	}
	return elementXml.replace(
		/^<(\w[\w-]*)/i,
		`<$1 ${name}='${replacementSafeValue}'`,
	)
}

export function removeRootIdAttribute(elementXml: string) {
	const openTagMatch = /^<(\w[\w-]*)([^>]*)>/i.exec(elementXml)
	if (!openTagMatch) return elementXml
	const tagName = openTagMatch[1] ?? ''
	let attributes = openTagMatch[2] ?? ''
	attributes = attributes.replace(/\s+id\s*=\s*(["'])(.*?)\1/i, '')
	return `<${tagName}${attributes}>${elementXml.slice(openTagMatch[0].length)}`
}

export type WlanPatch = {
	name?: string
	ssid?: string
	description?: string
	passphrase?: string
	saePassphrase?: string
	enableType?: 0 | 1
}

export function applyWlanPatch(elementXml: string, patch: WlanPatch) {
	let updated = elementXml
	if (patch.name !== undefined)
		updated = setOrAddAttribute(updated, 'name', patch.name)
	if (patch.ssid !== undefined)
		updated = setOrAddAttribute(updated, 'ssid', patch.ssid)
	if (patch.description !== undefined)
		updated = setOrAddAttribute(updated, 'description', patch.description)
	if (patch.enableType !== undefined)
		updated = setOrAddAttribute(
			updated,
			'enable-type',
			String(patch.enableType),
		)
	if (patch.passphrase !== undefined || patch.saePassphrase !== undefined) {
		const wpaRegex = /<wpa(?=[\s>/])([^>]*)(\/?>)/i
		const wpaMatch = wpaRegex.exec(updated)
		if (wpaMatch) {
			let wpaTag = wpaMatch[0]
			if (patch.passphrase !== undefined)
				wpaTag = setOrAddAttribute(wpaTag, 'passphrase', patch.passphrase)
			if (patch.saePassphrase !== undefined)
				wpaTag = setOrAddAttribute(
					wpaTag,
					'sae-passphrase',
					patch.saePassphrase,
				)
			updated = updated.replace(wpaRegex, escapeReplacementString(wpaTag))
		} else {
			const wpaAttrs: Array<string> = ["cipher='aes'", "dynamic-psk='disabled'"]
			if (patch.passphrase !== undefined)
				wpaAttrs.push(`passphrase='${escapeXmlAttribute(patch.passphrase)}'`)
			if (patch.saePassphrase !== undefined)
				wpaAttrs.push(
					`sae-passphrase='${escapeXmlAttribute(patch.saePassphrase)}'`,
				)
			const wpaTag = `<wpa ${wpaAttrs.join(' ')}/>`
			const wpaTagReplacement = escapeReplacementString(wpaTag)
			if (/\/>$/.test(updated)) {
				updated = updated.replace(/\/>$/, `>${wpaTagReplacement}</wlansvc>`)
			} else {
				updated = updated.replace(
					/<\/wlansvc>$/,
					`${wpaTagReplacement}</wlansvc>`,
				)
			}
		}
	}
	return updated
}
