import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason = 'Listing user-blocked rogue APs for operator review.'

/** List rogue access points that an operator has explicitly blocked. */
export async function listBlockedRogues(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<blocked-rogue/>',
		tagNames: ['rogue', 'blocked-rogue'],
		reason: input.reason ?? defaultReason,
	})
}
