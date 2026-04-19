import { type AppRecord } from '#worker/apps/types.ts'
import {
	deleteAppRow,
	getAppRowById,
	insertAppRow,
	listAppRowsByUserId,
	updateAppRow,
} from '#worker/apps/repo.ts'
import { formatScheduleSummary } from '#worker/jobs/schedule.ts'
import { type UiArtifactRow } from './ui-artifacts-types.ts'

export function uiArtifactVectorId(artifactId: string): string {
	return `app_${artifactId}`
}

function appToUiArtifactRow(app: AppRecord): UiArtifactRow {
	return {
		id: app.id,
		user_id: app.userId,
		title: app.title,
		description: app.description,
		sourceId: app.sourceId,
		hasClient: app.hasClient,
		hasServerCode: app.hasServer,
		taskNames: app.tasks.map((task) => task.name),
		jobNames: app.jobs.map((job) => job.name),
		scheduleSummaries: app.jobs.map((job) =>
			formatScheduleSummary({
				schedule: job.schedule,
				timezone: job.timezone,
			}),
		),
		parameters: app.parameters ? JSON.stringify(app.parameters) : null,
		hidden: app.hidden,
		created_at: app.createdAt,
		updated_at: app.updatedAt,
	}
}

function parseParametersJson(raw: string | null | undefined) {
	if (raw == null) return null
	try {
		return JSON.parse(raw) as Array<unknown> | null
	} catch {
		return null
	}
}

export async function insertUiArtifact(
	db: D1Database,
	row: Omit<UiArtifactRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	if (!row.sourceId) {
		throw new Error('Saved app requires a repo-backed source.')
	}
	await insertAppRow(db, {
		version: 1,
		id: row.id,
		userId: row.user_id,
		title: row.title,
		description: row.description,
		sourceId: row.sourceId,
		publishedCommit: null,
		hidden: row.hidden,
		keywords: [],
		searchText: null,
		parameters: parseParametersJson(row.parameters) as AppRecord['parameters'],
		hasClient: true,
		hasServer: row.hasServerCode,
		tasks: [],
		jobs: [],
		createdAt: row.created_at ?? now,
		updatedAt: row.updated_at ?? now,
	})
}

export async function getUiArtifactById(
	db: D1Database,
	userId: string,
	artifactId: string,
): Promise<UiArtifactRow | null> {
	const row = await getAppRowById(db, userId, artifactId)
	if (!row) return null
	return appToUiArtifactRow(row)
}

export async function getUiArtifactByOwnerIds(
	db: D1Database,
	userIds: Array<string>,
	artifactId: string,
): Promise<UiArtifactRow | null> {
	for (const userId of userIds.map((value) => value.trim()).filter(Boolean)) {
		const row = await getUiArtifactById(db, userId, artifactId)
		if (row) return row
	}
	return null
}

export async function deleteUiArtifact(
	db: D1Database,
	userId: string,
	artifactId: string,
): Promise<boolean> {
	return deleteAppRow(db, userId, artifactId)
}

export async function updateUiArtifact(
	db: D1Database,
	userId: string,
	artifactId: string,
	updates: Partial<
		Pick<
			UiArtifactRow,
			| 'title'
			| 'description'
			| 'sourceId'
			| 'hasServerCode'
			| 'parameters'
			| 'hidden'
		>
	>,
): Promise<boolean> {
	const existing = await getAppRowById(db, userId, artifactId)
	if (!existing) return false
	return updateAppRow(db, userId, {
		...existing,
		title: updates.title ?? existing.title,
		description: updates.description ?? existing.description,
		sourceId: updates.sourceId ?? existing.sourceId,
		hasClient: true,
		hasServer: updates.hasServerCode ?? existing.hasServer,
		parameters:
			updates.parameters === undefined
				? existing.parameters
				: (parseParametersJson(updates.parameters) as AppRecord['parameters']),
		hidden: updates.hidden ?? existing.hidden,
		updatedAt: new Date().toISOString(),
	})
}

export async function listUiArtifactsByUserId(
	db: D1Database,
	userId: string,
	options?: { hidden?: boolean },
): Promise<Array<UiArtifactRow>> {
	const hidden = options?.hidden
	const rows = await listAppRowsByUserId(db, userId)
	return rows
		.filter((row) => row.hasClient)
		.filter((row) => (hidden === undefined ? true : row.hidden === hidden))
		.map(appToUiArtifactRow)
}
