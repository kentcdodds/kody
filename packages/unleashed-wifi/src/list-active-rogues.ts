import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing currently detected rogue APs for operator review.'

/**
 * List currently detected rogue access points from the controller.
 *
 * Mirrors `aioruckus.RuckusAjaxApi.get_active_rogues`: filter the `<rogue>`
 * element with `LEVEL='1'` and `recognized='!true'` to exclude APs that have
 * already been marked as known by the operator.
 */
export async function listActiveRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: "<rogue LEVEL='1' recognized='!true'/>",
		tagNames: ['rogue'],
		reason: input.reason ?? defaultReason,
	})
}
