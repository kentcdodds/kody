import { BackupError, workflowInstanceId } from './backup-policy.ts'
import { type BackupPayload } from './backup-types.ts'

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
	create(options: { id: string; params: BackupPayload }): Promise<unknown>
	get(id: string): Promise<WorkflowHandle>
}

export type ExistingRetryResult = 'missing' | 'duplicate' | 'restarted'

export function isApprovedRetryWindow(scheduledAt: Date): boolean {
	const hour = scheduledAt.getUTCHours()
	return scheduledAt.getUTCMinutes() === 45 && hour >= 2 && hour <= 5
}

export async function enqueueBackup(
	workflow: WorkflowStarter,
	databaseId: string,
	payload: BackupPayload,
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

export async function retryExistingBackup(
	workflow: Pick<WorkflowStarter, 'get'>,
	databaseId: string,
	day: string,
): Promise<ExistingRetryResult> {
	const id = workflowInstanceId(databaseId, day)
	let instance: WorkflowHandle
	try {
		instance = await workflow.get(id)
	} catch {
		return 'missing'
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
			throw new BackupError(
				'workflow-status-unknown',
				'cannot safely retry an instance with unknown status',
			)
		default: {
			const exhaustive: never = status.status
			void exhaustive
			throw new BackupError(
				'workflow-status-unexpected',
				'cannot safely retry an instance with unexpected status',
			)
		}
	}
}
