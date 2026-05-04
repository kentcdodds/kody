import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed WLAN definitions for operator review.'

/** List configured WLANs on the controller. */
export async function listWlans(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<wlan-cfg/>',
		tagNames: ['wlansvc', 'wlan-cfg', 'wlan'],
		reason: input.reason ?? defaultReason,
	})
}
