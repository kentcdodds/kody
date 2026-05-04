import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Listing recognized rogue APs for operator review.'

/**
 * List rogue APs that an operator has marked as known/recognized.
 *
 * Mirrors `aioruckus.RuckusAjaxApi.get_known_rogues`: filter the `<rogue>`
 * element with `LEVEL='1'` and `recognized='true'`.
 */
export async function listKnownRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: "<rogue LEVEL='1' recognized='true'/>",
		tagNames: ['rogue'],
		reason: input.reason ?? defaultReason,
	})
}
