import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { escapeXmlAttribute, normalizeMacAddress } from './internal/xml.ts'

const defaultReason =
	'Provisioning a new dynamic PSK for the named WLAN at the operator request.'

export type AddDpskOptions = {
	user?: string
	mac?: string
	expiration?: string
}

/** Provision a new dynamic PSK (DPSK) under an existing WLAN. */
export async function addDpsk(input: {
	wlanName: string
	passphrase: string
	options?: AddDpskOptions
	reason?: string
}) {
	if (!input.passphrase.trim()) {
		throw new Error('@kentcdodds/unleashed-wifi: passphrase must not be empty.')
	}
	const { wlan } = await findWlanByName(input.wlanName)
	if (!wlan) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN "${input.wlanName}" was not found.`,
		)
	}
	const wlanId = String(wlan['id'] ?? '')
	let attributes =
		`wlansvc-id='${escapeXmlAttribute(wlanId)}' ` +
		`passphrase='${escapeXmlAttribute(input.passphrase)}'`
	if (input.options?.user !== undefined) {
		attributes += ` user='${escapeXmlAttribute(input.options.user)}'`
	}
	if (input.options?.mac !== undefined) {
		attributes += ` mac='${escapeXmlAttribute(normalizeMacAddress(input.options.mac))}'`
	}
	if (input.options?.expiration !== undefined) {
		attributes += ` expiration='${escapeXmlAttribute(input.options.expiration)}'`
	}
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: `<dpsk ${attributes}/>`,
		reason: input.reason ?? defaultReason,
	})
	return { wlanName: input.wlanName, ...result }
}
