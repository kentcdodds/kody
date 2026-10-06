export const firstCapabilityDispatchWarnMs = 250
export const firstCapabilityDispatchWarnTag =
	'kody-first-capability-dispatch-slow'

export function shouldWarnFirstCapabilityDispatch(durationMs: number) {
	return durationMs >= firstCapabilityDispatchWarnMs
}
