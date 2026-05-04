import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Disabling the named WLAN to take its SSID offline at the operator request.'

/** Disable a WLAN by service name. Disconnects all clients on that SSID. */
export async function disableWlan(input: { name: string; reason?: string }) {
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
			`enable-type='1' IS_PARTIAL='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, id, ...result }
}
