import { findWlanGroupByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Permanently deleting the named Access Networks Unleashed WLAN group. Member WLANs are not removed.'

/** Permanently delete a WLAN group by name. */
export async function deleteWlanGroup(input: {
	name: string
	reason?: string
}) {
	const { group } = await findWlanGroupByName(input.name)
	if (!group) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN group "${input.name}" was not found.`,
		)
	}
	const id = String(group['id'] ?? '')
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<wlangroup id='${escapeXmlAttribute(id)}' DELETE='true' IS_PARTIAL='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, id, ...result }
}
