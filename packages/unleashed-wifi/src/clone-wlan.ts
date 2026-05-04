import { findWlanByName } from './internal/lookups.ts'
import { unleashedRequest } from './internal/request.ts'
import { applyWlanPatch, removeRootIdAttribute } from './internal/xml.ts'

const defaultReason =
	'Cloning an existing WLAN under a new name. The clone inherits the source passphrase unless edited afterwards.'

/** Duplicate an existing WLAN with a new service name and SSID. */
export async function cloneWlan(input: {
	sourceName: string
	newName: string
	newSsid?: string
	reason?: string
}) {
	const { rawXml } = await findWlanByName(input.sourceName)
	if (!rawXml) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: source WLAN "${input.sourceName}" was not found.`,
		)
	}
	const sansId = removeRootIdAttribute(rawXml)
	const renamed = applyWlanPatch(sansId, {
		name: input.newName,
		ssid: input.newSsid ?? input.newName,
	})
	const result = await unleashedRequest({
		action: 'setconf',
		comp: 'stamgr',
		xmlBody: renamed,
		reason: input.reason ?? defaultReason,
	})
	return {
		sourceName: input.sourceName,
		newName: input.newName,
		...result,
	}
}
