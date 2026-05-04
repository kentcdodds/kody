import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Permanently deleting the named WLAN. All clients on that SSID will be disconnected and the WLAN cannot be recovered without re-creating it.'

/** Permanently delete a WLAN by service name. */
export async function deleteWlan(input: { name: string; reason?: string }) {
	const { wlan } = await findWlanByName(input.name)
	if (!wlan) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN "${input.name}" was not found.`,
		)
	}
	const id = String(wlan['id'] ?? '')
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<wlansvc id='${escapeXmlAttribute(id)}' DELETE='true' IS_PARTIAL='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, id, ...result }
}
