import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed dynamic PSKs for operator review.'

/** List configured dynamic pre-shared keys (DPSKs). */
export async function listDpsks(input: { reason?: string } = {}) {
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: '<dpsk/>',
		tagNames: ['dpsk'],
		reason: input.reason ?? defaultReason,
	})
}
