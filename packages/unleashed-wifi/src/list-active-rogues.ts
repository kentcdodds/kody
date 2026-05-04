import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing currently detected rogue APs for operator review.'

/** List currently detected rogue access points from the controller. */
export async function listActiveRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<rogue/>',
		tagNames: ['rogue'],
		reason: input.reason ?? defaultReason,
	})
}
