import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Blocking the requested wireless client from associating with the Access Networks Unleashed system ACL.'

/** Block a wireless client from the controller's system ACL. */
export async function blockClient(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const escaped = escapeXmlAttribute(mac)
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody:
			`<xcmd check-ability='10' tag='client' acl-id='1' client='${escaped}' cmd='block'>` +
			`<client client='${escaped}' acl-id='1' hostname=''/></xcmd>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
