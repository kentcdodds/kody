import { unleashedRequest } from './internal/request.ts'
import {
	escapeXmlAttribute,
	extractElementByAttribute,
	normalizeMacAddress,
} from './internal/xml.ts'

const defaultReason =
	'Removing a previously blocked wireless client from the Access Networks Unleashed system ACL.'

/** Remove a wireless client from the controller's system ACL. */
export async function unblockClient(input: { mac: string; reason?: string }) {
	const mac = normalizeMacAddress(input.mac)
	const lookup = await unleashedRequest({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<acl-list/>',
		reason: `Looking up the existing system ACL before unblocking ${mac}.`,
	})
	const aclXml = extractElementByAttribute({
		xml: lookup.xml,
		tagName: 'acl',
		attributeName: 'id',
		attributeValue: '1',
	})
	if (!aclXml) {
		throw new Error(
			'@kentcdodds/unleashed-wifi: system ACL (id=1) was not returned by the controller.',
		)
	}
	const escaped = escapeXmlAttribute(mac)
	const updatedAclXml = aclXml.replace(
		/<deny\b[^>]*\bmac\s*=\s*(["'])(?<deniedMac>.*?)\1[^>]*\/?>/gi,
		(match, _quote, deniedMac: string) =>
			deniedMac.toLowerCase() === escaped.toLowerCase() ? '' : match,
	)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<acl-list>${updatedAclXml}</acl-list>`,
		reason: input.reason ?? defaultReason,
	})
	return { mac, ...result }
}
