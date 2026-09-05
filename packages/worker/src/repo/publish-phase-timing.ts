export const publishExternalPushPhaseNames = [
	'clone',
	'checks/typecheck',
	'checks/bundle',
	'rebuild',
	'dependents',
] as const

export type PublishExternalPushPhase =
	(typeof publishExternalPushPhaseNames)[number]

/**
 * Stable capability-result field names for coarse
 * `packagePublishExternalPush` phase timings. Omitted keys mean that phase
 * did not run on this result. `checks_bundle_ms` and `rebuild_ms` stay
 * separate.
 */
export const publishPhaseTimingFields = [
	'clone_ms',
	'checks_typecheck_ms',
	'checks_bundle_ms',
	'rebuild_ms',
	'dependents_ms',
	'total_ms',
] as const

export type PublishPhaseTimingField = (typeof publishPhaseTimingFields)[number]

export type PublishPhaseTimings = {
	[K in PublishPhaseTimingField]?: number
}

export function publishPhaseTimingField(
	phase: PublishExternalPushPhase,
): Exclude<PublishPhaseTimingField, 'total_ms'> {
	switch (phase) {
		case 'clone':
			return 'clone_ms'
		case 'checks/typecheck':
			return 'checks_typecheck_ms'
		case 'checks/bundle':
			return 'checks_bundle_ms'
		case 'rebuild':
			return 'rebuild_ms'
		case 'dependents':
			return 'dependents_ms'
		default: {
			const exhaustive: never = phase
			throw new Error(`Unexpected publish phase: ${String(exhaustive)}`)
		}
	}
}

export function recordPublishPhaseTiming(
	timings: PublishPhaseTimings,
	phase: PublishExternalPushPhase,
	durationMs: number,
) {
	timings[publishPhaseTimingField(phase)] = durationMs
}

export function mergePublishPhaseTimings(
	...parts: Array<PublishPhaseTimings | undefined>
): PublishPhaseTimings {
	const merged: PublishPhaseTimings = {}
	for (const part of parts) {
		if (!part) continue
		for (const field of publishPhaseTimingFields) {
			const value = part[field]
			if (value !== undefined) {
				merged[field] = value
			}
		}
	}
	return merged
}

export function withPublishAttemptTotalMs(
	timings: PublishPhaseTimings,
	startedAt: number,
	endedAt = Date.now(),
): PublishPhaseTimings {
	return {
		...timings,
		total_ms: Math.max(0, endedAt - startedAt),
	}
}

export function attachPublishPhaseTimings<
	T extends { status: string; phase_timings?: PublishPhaseTimings },
>(result: T, phaseTimings: PublishPhaseTimings): T {
	if (result.status !== 'already_published' && result.status !== 'published') {
		return result
	}
	if (Object.keys(phaseTimings).length === 0) {
		return result
	}
	return {
		...result,
		phase_timings: phaseTimings,
	}
}

export function logPublishExternalPushPhase(input: {
	phase: PublishExternalPushPhase
	durationMs: number
	sourceId?: string
	publishedCommit?: string
}) {
	console.info(
		JSON.stringify({
			message: 'packagePublishExternalPush phase',
			phase: input.phase,
			durationMs: input.durationMs,
			...(input.sourceId ? { sourceId: input.sourceId } : {}),
			...(input.publishedCommit
				? { publishedCommit: input.publishedCommit }
				: {}),
		}),
	)
}

export async function timePublishExternalPushPhase<T>(
	input: {
		phase: PublishExternalPushPhase
		sourceId?: string
		publishedCommit?: string
		timings?: PublishPhaseTimings
	},
	work: () => Promise<T>,
): Promise<{ value: T; durationMs: number }> {
	const startedAt = Date.now()
	const finish = () => {
		const durationMs = Date.now() - startedAt
		logPublishExternalPushPhase({
			phase: input.phase,
			durationMs,
			...(input.sourceId ? { sourceId: input.sourceId } : {}),
			...(input.publishedCommit
				? { publishedCommit: input.publishedCommit }
				: {}),
		})
		if (input.timings) {
			recordPublishPhaseTiming(input.timings, input.phase, durationMs)
		}
		return durationMs
	}
	try {
		const value = await work()
		return { value, durationMs: finish() }
	} catch (error) {
		finish()
		throw error
	}
}
