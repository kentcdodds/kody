import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Reading per-AP-group statistics for operator review.'

/** Read per-AP-group statistics from the controller. */
export async function getApGroupStats(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'apStat',
		xmlBody: '<ap-group STATS="yes"/>',
		tagNames: ['apgroup', 'ap-group', 'group'],
		reason: input.reason ?? defaultReason,
	})
}
