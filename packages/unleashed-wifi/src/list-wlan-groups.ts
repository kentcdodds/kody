import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed WLAN groups for operator review.'

/** List configured WLAN groups on the controller. */
export async function listWlanGroups(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<wlan-group/>',
		tagNames: ['wlangroup', 'wlan-group'],
		reason: input.reason ?? defaultReason,
	})
}
