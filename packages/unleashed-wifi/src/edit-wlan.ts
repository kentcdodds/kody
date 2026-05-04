import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { applyWlanPatch } from './internal/xml.ts'

const defaultReason =
	'Editing the named WLAN. Connected clients on the affected SSID may briefly reconnect.'

export type EditWlanChanges = {
	ssid?: string
	description?: string
	passphrase?: string
	saePassphrase?: string
	enabled?: boolean
}

/** Apply targeted changes to an existing WLAN. */
export async function editWlan(input: {
	name: string
	changes: EditWlanChanges
	reason?: string
}) {
	const { rawXml } = await findWlanByName(input.name)
	if (!rawXml) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: WLAN "${input.name}" was not found.`,
		)
	}
	const patch: Parameters<typeof applyWlanPatch>[1] = {}
	if (input.changes.ssid !== undefined) patch.ssid = input.changes.ssid
	if (input.changes.description !== undefined) {
		patch.description = input.changes.description
	}
	if (input.changes.passphrase !== undefined) {
		patch.passphrase = input.changes.passphrase
	}
	if (input.changes.saePassphrase !== undefined) {
		patch.saePassphrase = input.changes.saePassphrase
	} else if (input.changes.passphrase !== undefined) {
		patch.saePassphrase = input.changes.passphrase
	}
	if (input.changes.enabled !== undefined) {
		patch.enableType = input.changes.enabled ? 0 : 1
	}
	const updated = applyWlanPatch(rawXml, patch)
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: updated,
		reason: input.reason ?? defaultReason,
	})
	return { name: input.name, ...result }
}
