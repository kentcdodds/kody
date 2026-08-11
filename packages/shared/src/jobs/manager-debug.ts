export type JobManagerDebugStatus =
	| 'missing_binding'
	| 'idle'
	| 'armed'
	| 'out_of_sync'

export type JobManagerDebugState = {
	bindingAvailable: boolean
	status: JobManagerDebugStatus
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}
