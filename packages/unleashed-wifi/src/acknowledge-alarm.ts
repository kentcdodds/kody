import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Acknowledging the named Access Networks Unleashed alarm so it stops appearing in the live alarm list.'

/** Acknowledge a specific alarm by id. */
export async function acknowledgeAlarm(input: { id: string; reason?: string }) {
	const id = input.id.trim()
	if (!id) {
		throw new Error('@kentcdodds/unleashed-wifi: id must not be empty.')
	}
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody: `<xcmd cmd='ack-alarm' tag='alarm' id='${escapeXmlAttribute(id)}'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { id, ...result }
}
