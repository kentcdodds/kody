import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing recently inactive Access Networks Unleashed clients for operator review.'

/** List historical/inactive wireless clients reported by the controller. */
export async function listInactiveClients(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<client INACTIVE-STATS="yes"/>',
		tagNames: ['client'],
		reason: input.reason ?? defaultReason,
	})
}
