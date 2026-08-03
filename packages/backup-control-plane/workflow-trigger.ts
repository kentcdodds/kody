import { workflowInstanceId } from './backup-policy.ts'
import { type ScheduledBackupPayload } from './backup-types.ts'

export type WorkflowInstanceStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'errored'
	| 'terminated'
	| 'complete'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown'

export type EnqueueResult = 'created' | 'duplicate' | 'restarted'

interface WorkflowHandle {
	status(): Promise<{ status: WorkflowInstanceStatus }>
	restart(): Promise<void>
}

interface WorkflowStarter {
	create(options: {
		id: string
		params: ScheduledBackupPayload
	}): Promise<unknown>
	get(id: string): Promise<WorkflowHandle>
}

export type RetryTickResult = EnqueueResult | 'outside-window'

export function isApprovedRetryWindow(scheduledAt: Date): boolean {
	const hour = scheduledAt.getUTCHours()
	return scheduledAt.getUTCMinutes() === 45 && hour >= 2 && hour <= 5
}

export function primaryBackupTimeForDay(scheduledAt: Date): Date {
	return new Date(
		Date.UTC(
			scheduledAt.getUTCFullYear(),
			scheduledAt.getUTCMonth(),
			scheduledAt.getUTCDate(),
			2,
			15,
		),
	)
}

export async function enqueueBackup(
	workflow: WorkflowStarter,
	databaseId: string,
	payload: ScheduledBackupPayload,
): Promise<EnqueueResult> {
	const id = workflowInstanceId(databaseId, payload.day)
	try {
		await workflow.create({
			id,
			params: payload,
		})
		return 'created'
	} catch (createError) {
		let instance: WorkflowHandle
		try {
			instance = await workflow.get(id)
		} catch {
			// Preserve the original create failure when no instance can be proven.
			throw createError
		}
		const status = await instance.status()
		switch (status.status) {
			case 'queued':
			case 'running':
			case 'paused':
			case 'complete':
			case 'waiting':
			case 'waitingForPause':
				return 'duplicate'
			case 'errored':
			case 'terminated':
				await instance.restart()
				return 'restarted'
			case 'unknown':
				throw createError
			default: {
				const exhaustive: never = status.status
				void exhaustive
				throw createError
			}
		}
	}
}

export async function enqueueBackupRetry(
	workflow: WorkflowStarter,
	databaseId: string,
	payload: ScheduledBackupPayload,
	scheduledAt: Date,
): Promise<RetryTickResult> {
	if (!isApprovedRetryWindow(scheduledAt)) return 'outside-window'
	return enqueueBackup(workflow, databaseId, payload)
}
