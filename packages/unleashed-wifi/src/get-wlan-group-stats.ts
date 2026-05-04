import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Reading per-WLAN-group statistics for operator review.'

/** Read per-WLAN-group statistics from the controller. */
export async function getWlanGroupStats(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<wlan-group STATS="yes"/>',
		tagNames: ['wlangroup', 'wlan-group', 'wlan'],
		reason: input.reason ?? defaultReason,
	})
}
