import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Marking a detected rogue AP as known/recognized so it stops triggering rogue alerts.'

/** Mark a detected rogue AP as known/recognized. */
export async function markRogueKnown(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<known-rogue mac='${escapeXmlAttribute(mac)}' recognized='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
