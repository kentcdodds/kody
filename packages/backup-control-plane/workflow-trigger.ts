import { workflowInstanceId } from './backup-policy.ts'
import { type BackupPayload } from './backup-types.ts'

interface WorkflowHandle {
	status(): Promise<{ status: string }>
}

interface WorkflowStarter {
	create(options: {
		id: string
		params: BackupPayload
		retention: {
			successRetention: '1 year'
			errorRetention: '1 year'
		}
	}): Promise<unknown>
	get(id: string): Promise<WorkflowHandle>
}

export async function enqueueBackup(
	workflow: WorkflowStarter,
	databaseId: string,
	payload: BackupPayload,
): Promise<'created' | 'duplicate'> {
	const id = workflowInstanceId(databaseId, payload.day)
	try {
		await workflow.create({
			id,
			params: payload,
			retention: {
				successRetention: '1 year',
				errorRetention: '1 year',
			},
		})
		return 'created'
	} catch (createError) {
		try {
			const status = await (await workflow.get(id)).status()
			if (status.status !== 'unknown') return 'duplicate'
		} catch {
			// Preserve the original create failure when no instance can be proven.
		}
		throw createError
	}
}
