import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Enabling the named WLAN to bring its SSID back online at the operator request.'

/** Enable a WLAN by service name. */
export async function enableWlan(input: { name: string; reason?: string }) {
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
		xmlBody:
			`<wlansvc id='${escapeXmlAttribute(id)}' ` +
			`name='${escapeXmlAttribute(input.name)}' ` +
			`enable-type='0' IS_PARTIAL='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, id, ...result }
}
