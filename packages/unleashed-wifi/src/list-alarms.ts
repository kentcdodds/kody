import { listUnleashed } from './internal/list-helpers.ts'

const defaultReason =
	'Listing Access Networks Unleashed alarms for operator review.'
const defaultLimit = 50

function clampLimit(limit: number | undefined) {
	if (limit == null || !Number.isFinite(limit)) return defaultLimit
	return Math.max(1, Math.min(1_000, Math.trunc(limit)))
}

/** List active alarms reported by the controller. */
export async function listAlarms(
	input: { limit?: number; reason?: string } = {},
) {
	const limit = clampLimit(input.limit)
	return await listUnleashed({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: `<alarm limit="${limit}"/>`,
		tagNames: ['alarm'],
		reason: input.reason ?? defaultReason,
	})
}
