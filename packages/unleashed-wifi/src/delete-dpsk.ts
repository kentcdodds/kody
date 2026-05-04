import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Removing the named dynamic PSK from the controller at the operator request.'

/** Permanently delete a dynamic PSK by id. */
export async function deleteDpsk(input: { id: string; reason?: string }) {
	const id = input.id.trim()
	if (!id) {
		throw new Error('@kentcdodds/unleashed-wifi: id must not be empty.')
	}
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<dpsk id='${escapeXmlAttribute(id)}' DELETE='true'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { id, ...result }
}
