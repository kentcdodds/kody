export const publishExternalPushPhaseNames = [
	'clone',
	'checks/typecheck',
	'checks/bundle',
	'rebuild',
	'dependents',
] as const

export type PublishExternalPushPhase =
	(typeof publishExternalPushPhaseNames)[number]

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
