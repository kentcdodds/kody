import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing recent Access Networks Unleashed controller events for operator review.'
const defaultLimit = 100

function clampLimit(limit: number | undefined) {
	if (limit == null || !Number.isFinite(limit)) return defaultLimit
	return Math.max(1, Math.min(1_000, Math.trunc(limit)))
}

/** List recent controller events. */
export async function listEvents(
	input: { limit?: number; reason?: string } = {},
) {
	const limit = clampLimit(input.limit)
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: `<event limit="${limit}"/>`,
		tagNames: ['xevent', 'event'],
		reason: input.reason ?? defaultReason,
	})
}
