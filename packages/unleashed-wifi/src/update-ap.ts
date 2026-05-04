import { findApByMac } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Updating an access point name, location, or AP-group membership at the operator request.'

export type UpdateApChanges = {
	deviceName?: string
	location?: string
	apGroupId?: string
}

function appendAttribute(target: string, name: string, value: string) {
	return `${target} ${name}='${escapeXmlAttribute(value)}'`
}

/** Update an access point's display name, location, or AP-group membership. */
export async function updateAp(input: {
	mac: string
	changes: UpdateApChanges
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const { ap } = await findApByMac(mac)
	if (!ap) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: access point "${mac}" was not found.`,
		)
	}
	const id = String(ap['id'] ?? '')
	let attributes = `id='${escapeXmlAttribute(id)}' IS_PARTIAL='true'`
	if (input.changes.deviceName !== undefined) {
		attributes = appendAttribute(
			attributes,
			'devname',
			input.changes.deviceName,
		)
	}
	if (input.changes.location !== undefined) {
		attributes = appendAttribute(attributes, 'location', input.changes.location)
	}
	if (input.changes.apGroupId !== undefined) {
		attributes = appendAttribute(
			attributes,
			'apgroup-id',
			input.changes.apGroupId,
		)
	}
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'apStat',
		xmlBody: `<ap ${attributes}/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, id, ...result }
}
