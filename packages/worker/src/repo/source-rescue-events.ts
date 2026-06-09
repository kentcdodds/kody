import { type EntityKind } from './types.ts'

export type InsertSourceRescueEventInput = {
	userId: string
	sourceId: string
	entityKind: EntityKind
	entityId: string
	packageId: string | null
	kodyId: string | null
	sourceRepoId: string
	recoveryKind: 'repo_session'
	recoveredSessionId: string | null
	recoveredRepoId: string | null
	recoveredRepoName: string | null
	recoveredCommit: string | null
	priorPublishedCommit: string | null
	sourceHeadBefore: string | null
	sourceHeadAfter: string | null
	operatorUserId: string
	operatorEmail: string | null
	validationStatus: 'passed' | 'failed'
	validationJson: string
	metadataJson?: string | null
}

export async function insertSourceRescueEvent(
	db: D1Database,
	input: InsertSourceRescueEventInput,
) {
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO source_rescue_events (
				id, user_id, source_id, entity_kind, entity_id, package_id, kody_id,
				source_repo_id, recovery_kind, recovered_session_id, recovered_repo_id,
				recovered_repo_name, recovered_commit, prior_published_commit,
				source_head_before, source_head_after, operator_user_id, operator_email,
				validation_status, validation_json, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.userId,
			input.sourceId,
			input.entityKind,
			input.entityId,
			input.packageId,
			input.kodyId,
			input.sourceRepoId,
			input.recoveryKind,
			input.recoveredSessionId,
			input.recoveredRepoId,
			input.recoveredRepoName,
			input.recoveredCommit,
			input.priorPublishedCommit,
			input.sourceHeadBefore,
			input.sourceHeadAfter,
			input.operatorUserId,
			input.operatorEmail,
			input.validationStatus,
			input.validationJson,
			input.metadataJson ?? null,
			now,
		)
		.run()
	return id
}
