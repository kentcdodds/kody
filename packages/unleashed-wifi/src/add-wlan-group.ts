import { listWlans } from './list-wlans.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Creating a new Access Networks Unleashed WLAN group. Member WLANs will be exposed by the AP groups that reference this group.'

/** Create a new WLAN group, optionally containing existing WLANs. */
export async function addWlanGroup(input: {
	name: string
	description?: string
	wlanNames?: Array<string>
	reason?: string
}) {
	if (!input.name.trim()) {
		throw new Error('@kentcdodds/unleashed-wifi: name must not be empty.')
	}
	let body =
		`<wlangroup name='${escapeXmlAttribute(input.name)}' ` +
		`description='${escapeXmlAttribute(input.description ?? '')}'>`
	if (input.wlanNames && input.wlanNames.length > 0) {
		const { items } = await listWlans({
			reason: `Resolving WLAN ids for the new WLAN group "${input.name}".`,
		})
		const wlanByName = new Map(
			items.map(
				(item) =>
					[String(item['name'] ?? ''), String(item['id'] ?? '')] as const,
			),
		)
		for (const wlanName of input.wlanNames) {
			if (!wlanByName.has(wlanName)) {
				throw new Error(
					`@kentcdodds/unleashed-wifi: WLAN "${wlanName}" was not found while creating WLAN group "${input.name}".`,
				)
			}
			const id = wlanByName.get(wlanName) ?? ''
			if (!id) {
				throw new Error(
					`@kentcdodds/unleashed-wifi: WLAN "${wlanName}" was returned by the controller without an id.`,
				)
			}
			body += `<wlansvc id='${escapeXmlAttribute(id)}'/>`
		}
	}
	body += `</wlangroup>`
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: body,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, ...result }
}
