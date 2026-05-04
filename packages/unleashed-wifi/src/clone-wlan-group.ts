import { findWlanGroupByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, getAttributeValue } from './internal/xml.ts'

const defaultReason =
	'Duplicating an existing WLAN group with the same WLAN membership at the operator request.'

/** Duplicate an existing WLAN group with a new name and the same members. */
export async function cloneWlanGroup(input: {
	sourceName: string
	newName: string
	description?: string
	reason?: string
}) {
	const { rawXml } = await findWlanGroupByName(input.sourceName)
	if (!rawXml) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN group "${input.sourceName}" was not found.`,
		)
	}
	const sourceDescription = getAttributeValue(rawXml, 'description') ?? ''
	const memberIds: Array<string> = []
	const memberRegex = /<wlansvc\b[^>]*\bid\s*=\s*(["'])(.*?)\1[^>]*\/?>/gi
	for (const match of rawXml.matchAll(memberRegex)) {
		if (match[2]) memberIds.push(match[2])
	}
	let body =
		`<wlangroup name='${escapeXmlAttribute(input.newName)}' ` +
		`description='${escapeXmlAttribute(input.description ?? sourceDescription)}'>`
	for (const id of memberIds) {
		body += `<wlansvc id='${escapeXmlAttribute(id)}'/>`
	}
	body += `</wlangroup>`
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: body,
		reason: input.reason ?? defaultReason,
	})
	return { sourceName: input.sourceName, newName: input.newName, ...result }
}
