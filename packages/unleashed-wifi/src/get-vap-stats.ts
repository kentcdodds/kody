import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Reading per-VAP throughput statistics for operator review.'

/** Read per-VAP (per-radio WLAN) throughput statistics from the controller. */
export async function getVapStats(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<vap/>',
		tagNames: ['vap'],
		reason: input.reason ?? defaultReason,
	})
}
