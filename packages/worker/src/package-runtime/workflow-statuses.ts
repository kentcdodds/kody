export type WorkflowRunStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown'
	| 'complete'
	| 'errored'
	| 'terminated'
	| 'cancelled'

export const activeWorkflowStatusValues = [
	'queued',
	'running',
	'paused',
	'waiting',
	'waitingForPause',
	'unknown',
] as const satisfies ReadonlyArray<WorkflowRunStatus>

export const terminalWorkflowStatusValues = [
	'complete',
	'errored',
	'terminated',
	'cancelled',
] as const satisfies ReadonlyArray<WorkflowRunStatus>

/**
 * Terminal statuses that mean the durable work did not succeed. `complete` is
 * excluded so a finished run can still satisfy same-key replay. Callers that
 * release an idempotency key after failure use this set so cancelled stays
 * aligned with the cancel projection.
 */
export const deadTerminalWorkflowStatusValues =
	terminalWorkflowStatusValues.filter((status) => status !== 'complete')

export function isDeadTerminalWorkflowStatus(
	status: string | null | undefined,
): boolean {
	return (
		status != null &&
		(deadTerminalWorkflowStatusValues as ReadonlyArray<string>).includes(status)
	)
}

/** Rewrite a projection's key so same-key lookups miss this dead run. */
export function releasedWorkflowProjectionIdempotencyKey(workflowId: string) {
	const id = workflowId.trim()
	if (!id) {
		throw new Error('releasedWorkflowProjectionIdempotencyKey requires an id.')
	}
	return `released:${id}`
}
