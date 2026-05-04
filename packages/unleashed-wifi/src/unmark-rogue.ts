import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Removing a rogue AP from the known-rogue and blocked-rogue lists at the operator request.'

/** Remove a rogue AP from both the known-rogue and blocked-rogue lists. */
export async function unmarkRogue(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody:
			`<known-rogue mac='${escapeXmlAttribute(mac)}' DELETE='true'/>` +
			`<blocked-rogue mac='${escapeXmlAttribute(mac)}' DELETE='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
