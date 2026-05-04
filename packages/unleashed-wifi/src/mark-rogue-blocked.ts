import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Adding a rogue AP to the user-blocked list so the controller actively suppresses it.'

/**
 * Mark a detected rogue AP as user-blocked.
 *
 * Cross-referenced with `aioruckus`: the `<rogue>` element carries the
 * `blocked` attribute when listing blocked rogues; the inverse setconf payload
 * writes the same attribute back to the controller.
 */
export async function markRogueBlocked(input: {
	mac: string
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const escaped = escapeXmlAttribute(mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<rogue mac='${escaped}' blocked='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
