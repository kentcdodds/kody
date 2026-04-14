import {
	deleteJob,
	getJobById,
	insertJob,
	listJobsByUserId,
	updateJob,
} from './repo.ts'
import { normalizeJobSchedule, normalizeJobTimezone } from './schedule.ts'
import {
	type JobCreateInput,
	type JobRecord,
	type JobUpdatePatch,
} from './types.ts'

export const jobStorageBindingPrefix = 'job:'

export function buildJobStorageBindingId(jobId: string) {
	return `${jobStorageBindingPrefix}${jobId}`
}

export function normalizeJobName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) {
		throw new Error('Jobs require a non-empty name.')
	}
	return trimmed
}

export function normalizeJobServerCode(serverCode: string) {
	const trimmed = serverCode.trim()
	if (!trimmed) {
		throw new Error('Jobs require non-empty server code.')
	}
	return trimmed
}

export async function createJobRecord(input: {
	db: D1Database
	userId: string
	data: JobCreateInput
}) {
	const id = crypto.randomUUID()
	const serverCodeId = crypto.randomUUID()
	const now = new Date().toISOString()
	const record: JobRecord = {
		id,
		userId: input.userId,
		name: normalizeJobName(input.data.name),
		serverCode: normalizeJobServerCode(input.data.serverCode),
		serverCodeId,
		schedule: normalizeJobSchedule(input.data.schedule),
		timezone: normalizeJobTimezone(input.data.timezone),
		enabled: input.data.enabled ?? true,
		createdAt: now,
		updatedAt: now,
	}
	await insertJob(input.db, {
		id: record.id,
		user_id: record.userId,
		name: record.name,
		serverCode: record.serverCode,
		serverCodeId: record.serverCodeId,
		schedule: record.schedule,
		timezone: record.timezone,
		enabled: record.enabled,
		created_at: record.createdAt,
		updated_at: record.updatedAt,
	})
	return record
}

export async function updateJobRecord(input: {
	db: D1Database
	userId: string
	jobId: string
	patch: JobUpdatePatch
}) {
	const existing = await getJobById(input.db, input.userId, input.jobId)
	if (!existing) {
		throw new Error(`Job "${input.jobId}" was not found.`)
	}

	const nextServerCode =
		input.patch.serverCode === undefined
			? existing.serverCode
			: normalizeJobServerCode(input.patch.serverCode)
	const nextServerCodeId =
		input.patch.serverCode === undefined
			? existing.serverCodeId
			: crypto.randomUUID()
	const nextSchedule =
		input.patch.schedule === undefined
			? existing.schedule
			: normalizeJobSchedule(input.patch.schedule)
	const nextTimezone =
		input.patch.timezone === undefined
			? existing.timezone
			: normalizeJobTimezone(input.patch.timezone)
	const nextEnabled = input.patch.enabled ?? existing.enabled
	const nextName =
		input.patch.name === undefined
			? existing.name
			: normalizeJobName(input.patch.name)
	const nextRecord: JobRecord = {
		...existing,
		name: nextName,
		serverCode: nextServerCode,
		serverCodeId: nextServerCodeId,
		schedule: nextSchedule,
		timezone: nextTimezone,
		enabled: nextEnabled,
		updatedAt: new Date().toISOString(),
	}

	await updateJob(input.db, input.userId, input.jobId, {
		name: nextRecord.name,
		serverCode: nextRecord.serverCode,
		serverCodeId: nextRecord.serverCodeId,
		schedule: nextRecord.schedule,
		timezone: nextRecord.timezone,
		enabled: nextRecord.enabled,
	})
	return {
		before: existing,
		after: nextRecord,
		serverCodeChanged: existing.serverCodeId !== nextRecord.serverCodeId,
		scheduleChanged:
			JSON.stringify(existing.schedule) !==
				JSON.stringify(nextRecord.schedule) ||
			existing.timezone !== nextRecord.timezone ||
			existing.enabled !== nextRecord.enabled,
	}
}

export async function requireJobRecord(
	db: D1Database,
	userId: string,
	jobId: string,
) {
	const job = await getJobById(db, userId, jobId)
	if (!job) {
		throw new Error(`Job "${jobId}" was not found.`)
	}
	return job
}

export async function removeJobRecord(
	db: D1Database,
	userId: string,
	jobId: string,
) {
	return await deleteJob(db, userId, jobId)
}

export async function listJobRecords(db: D1Database, userId: string) {
	return await listJobsByUserId(db, userId)
}
