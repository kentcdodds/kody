import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed access point groups for operator review.'

/** List access point groups configured on the controller. */
export async function listApGroups(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'apStat',
		xmlBody: '<ap-group/>',
		tagNames: ['apgroup', 'ap-group', 'group'],
		reason: input.reason ?? defaultReason,
	})
}
