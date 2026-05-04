import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing currently associated Access Networks Unleashed clients for operator review.'

/** List currently active wireless clients on the controller. */
export async function listClients(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<client/>',
		tagNames: ['client'],
		reason: input.reason ?? defaultReason,
	})
}
