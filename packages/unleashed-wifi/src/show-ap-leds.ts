import { findApByMac } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Turning on the LEDs on the named access point to make it visible again for diagnostics.'

/** Turn on the status LEDs on a single access point. */
export async function showApLeds(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const { ap } = await findApByMac(mac)
	if (!ap) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: access point "${mac}" was not found.`,
		)
	}
	const id = String(ap['id'] ?? '')
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'apStat',
		xmlBody: `<ap id='${escapeXmlAttribute(id)}' IS_PARTIAL='true' led-off='false'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, id, ...result }
}
