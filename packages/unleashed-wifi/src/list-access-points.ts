import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed access points for operator review.'

/** List the live access points reported by the controller. */
export async function listAccessPoints(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'apStat',
		xmlBody: '<apStat/>',
		tagNames: ['ap', 'apStat'],
		reason: input.reason ?? defaultReason,
	})
}
