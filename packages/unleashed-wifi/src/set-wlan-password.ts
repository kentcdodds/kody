import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { applyWlanPatch } from './internal/xml.ts'

const defaultReason =
	'Rotating the passphrase on the named WLAN. All currently connected clients on that SSID will reconnect.'

/** Set or rotate the passphrase for an existing WLAN. */
export async function setWlanPassword(input: {
	name: string
	passphrase: string
	saePassphrase?: string
	reason?: string
}) {
	if (!input.passphrase.trim()) {
		throw new Error('@kentcdodds/unleashed-wifi: passphrase must not be empty.')
	}
	const { rawXml } = await findWlanByName(input.name)
	if (!rawXml) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN "${input.name}" was not found.`,
		)
	}
	const updated = applyWlanPatch(rawXml, {
		passphrase: input.passphrase,
		saePassphrase: input.saePassphrase ?? input.passphrase,
	})
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: updated,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, ...result }
}
