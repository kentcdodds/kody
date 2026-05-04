import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Rebooting the named access point. All clients currently associated with that AP will briefly disconnect.'

/** Reboot an access point by MAC address. */
export async function restartAccessPoint(input: {
	mac: string
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'system',
		xmlBody: `<xcmd cmd='reset' ap='${escapeXmlAttribute(mac)}' tag='ap' checkAbility='2'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
