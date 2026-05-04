import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Adding a rogue AP to the blocked-rogue list so the controller actively suppresses it.'

/** Mark a detected rogue AP as user-blocked. */
export async function markRogueBlocked(input: {
	mac: string
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<blocked-rogue mac='${escapeXmlAttribute(mac)}' blocked='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
