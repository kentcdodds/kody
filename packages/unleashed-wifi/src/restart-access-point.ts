import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Rebooting the named access point. All clients currently associated with that AP will briefly disconnect.'

/**
 * Reboot an access point by MAC address.
 *
 * Cross-referenced with `aioruckus.RuckusAjaxApi.do_restart_ap`, which targets
 * `comp='stamgr'` (not `comp='system'`) when issuing a `reset` xcmd against an
 * AP. The original task spec listed `system` here but aioruckus has been
 * exercised against real Unleashed/ZoneDirector controllers, so we follow it.
 */
export async function restartAccessPoint(input: {
	mac: string
	reason?: string
}) {
	const mac = normalizeMacAddress(input.mac)
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody:
			`<xcmd cmd='reset' ap='${escapeXmlAttribute(mac)}' ` +
			`tag='ap' checkAbility='2'/>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
