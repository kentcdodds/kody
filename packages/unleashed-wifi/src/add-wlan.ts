import { unleashedRequest } from './internal/request.ts'
import { applyWlanPatch, escapeXmlAttribute } from './internal/xml.ts'

const defaultReason =
	'Creating a new WLAN/SSID on the controller. All member access points will start broadcasting it immediately.'

export type AddWlanOptions = {
	/** Optional WLAN service name. Defaults to the SSID. */
	name?: string
	/** Optional WPA3 SAE passphrase. Defaults to the WPA2 passphrase. */
	saePassphrase?: string
	/** Optional human-readable description. */
	description?: string
}

/** Create a new WLAN on the controller using a default WPA2 template. */
export async function addWlan(input: {
	ssid: string
	passphrase: string
	options?: AddWlanOptions
	reason?: string
}) {
	const ssid = input.ssid.trim()
	if (!ssid) {
		throw new Error('@kentcdodds/unleashed-wifi: ssid must not be empty.')
	}
	if (!input.passphrase.trim()) {
		throw new Error('@kentcdodds/unleashed-wifi: passphrase must not be empty.')
	}
	const name = input.options?.name?.trim() || ssid
	const description = input.options?.description?.trim()
	const saePassphrase = input.options?.saePassphrase ?? input.passphrase
	const wlanXml =
		`<wlansvc name='${escapeXmlAttribute(name)}' ` +
		`ssid='${escapeXmlAttribute(ssid)}' ` +
		`encryption='wpa2' authentication='open' is-guest='false'></wlansvc>`
	const populated = applyWlanPatch(wlanXml, {
		description: description ?? '',
		passphrase: input.passphrase,
		saePassphrase,
	})
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: populated,
		reason: input.reason ?? defaultReason,
	})
	return { name, ssid, ...result }
}
