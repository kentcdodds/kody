export const firstCapabilityDispatchWarnMs = 250
export const firstCapabilityDispatchWarnTag =
	'kody-first-capability-dispatch-slow'

function isVitestRuntime() {
	const runtimeProcess = (
		globalThis as { process?: { env?: Record<string, unknown> } }
	).process
	return Boolean(runtimeProcess?.env?.VITEST)
}

export function shouldWarnFirstCapabilityDispatch(
	durationMs: number,
	options?: { probeEnabled?: boolean; warnMs?: number },
) {
	const probeEnabled = options?.probeEnabled ?? !isVitestRuntime()
	if (!probeEnabled) return false
	return durationMs >= (options?.warnMs ?? firstCapabilityDispatchWarnMs)
}
