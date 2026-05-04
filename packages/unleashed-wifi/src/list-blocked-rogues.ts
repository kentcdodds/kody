import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Listing user-blocked rogue APs for operator review.'

/**
 * List rogue APs that an operator has explicitly added to the user-blocked
 * list.
 *
 * Mirrors `aioruckus.RuckusAjaxApi.get_blocked_rogues`: filter the `<rogue>`
 * element with `LEVEL='1'` and `blocked='true'`.
 */
export async function listBlockedRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: "<rogue LEVEL='1' blocked='true'/>",
		tagNames: ['rogue'],
		reason: input.reason ?? defaultReason,
	})
}
