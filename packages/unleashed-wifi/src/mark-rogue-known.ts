import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Marking a detected rogue AP as known/recognized so it stops triggering rogue alerts.'

/**
 * Mark a detected rogue AP as known/recognized.
 *
 * Cross-referenced with `aioruckus`: the `<rogue>` element carries the
 * `recognized` attribute when listing known rogues, and the inverse setconf
 * payload writes the same attribute back to the controller. The previous
 * `<known-rogue>` element name was incorrect — the controller silently
 * accepted it but produced no observable change.
 */
export async function markRogueKnown(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const escaped = escapeXmlAttribute(mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<rogue mac='${escaped}' recognized='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
