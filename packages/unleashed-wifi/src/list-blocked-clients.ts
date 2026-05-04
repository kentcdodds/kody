import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing currently blocked Access Networks Unleashed clients for operator review.'

/** List wireless clients that are currently denied access by the system ACL. */
export async function listBlockedClients(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<blocked-client/>',
		tagNames: ['blocked-client', 'deny', 'client'],
		reason: input.reason ?? defaultReason,
	})
}
