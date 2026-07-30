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
