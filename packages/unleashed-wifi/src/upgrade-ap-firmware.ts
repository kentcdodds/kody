import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Triggering a firmware upgrade for the named access point. The AP will reboot once the upgrade completes.'

/** Trigger a firmware upgrade for a single access point by MAC address. */
export async function upgradeApFirmware(input: {
	mac: string
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'system',
		xmlBody: `<xcmd cmd='upgrade' tag='ap' ap='${escapeXmlAttribute(mac)}' checkAbility='2'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
