import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Listing recognized rogue APs for operator review.'

/** List recognized/known rogue access points. */
export async function listKnownRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<known-rogue/>',
		tagNames: ['rogue', 'known-rogue'],
		reason: input.reason ?? defaultReason,
	})
}
