import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Removing a rogue AP from both the known-rogue and user-blocked lists.'

/**
 * Reset a rogue AP so it is treated as freshly detected: clear the
 * `recognized` and `blocked` attributes that `mark-rogue-known` and
 * `mark-rogue-blocked` set.
 *
 * Like the marker helpers, this targets the same `<rogue>` element that
 * `aioruckus` uses for listing — the previous attempt that posted
 * `<known-rogue ... DELETE='true'/>` was wrong.
 */
export async function unmarkRogue(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const escaped = escapeXmlAttribute(mac)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<rogue mac='${escaped}' recognized='false' blocked='false'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
