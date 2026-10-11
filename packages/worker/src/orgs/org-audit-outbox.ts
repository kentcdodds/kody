import { runD1WithRetry } from '#worker/d1-retry.ts'

export type OrgAuditWriter = {
	appDb: D1Database
	db: D1Database
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
	credentialId: string | null
}

export type OrgAuditOutboxPayload = {
	id: string
	orgId: string
	action: string
	result: 'success' | 'failure' | 'denied'
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
	credentialId: string | null
	resourceType: string | null
	resourceId: string | null
	targetUserId: string | null
	detailsJson: string | null
	ipHash: string | null
	createdAt: string
}

export type OrgAuditOutboxPlan = {
	outboxId: string
	payload: OrgAuditOutboxPayload
}

export type OrgAuditOutboxEvent = {
	orgId: string
	action: string
	resourceType?: string | null
	resourceId?: string | null
	targetUserId?: string | null
	details?: Record<string, unknown>
}

function serializeDetails(event: OrgAuditOutboxEvent): string | null {
	if (event.details === undefined) return null
	return JSON.stringify(event.details)
}

export function buildOrgAuditOutboxPayload(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): OrgAuditOutboxPayload {
	const createdAt = new Date().toISOString()
	return {
		id: crypto.randomUUID(),
		orgId: event.orgId,
		action: event.action,
		result: 'success',
		actorUserId: writer.actorUserId,
		actorUsername: writer.actorUsername,
		credentialKind: writer.credentialKind,
		credentialId: writer.credentialId,
		resourceType: event.resourceType ?? null,
		resourceId: event.resourceId ?? null,
		targetUserId: event.targetUserId ?? null,
		detailsJson: serializeDetails(event),
		ipHash: null,
		createdAt,
	}
}

export function planOrgAuditOutbox(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): OrgAuditOutboxPlan {
	const payload = buildOrgAuditOutboxPayload(writer, event)
	return { outboxId: payload.id, payload }
}

export function orgAuditOutboxInsertStatement(
	appDb: D1Database,
	plan: OrgAuditOutboxPlan,
) {
	return appDb
		.prepare(
			`INSERT INTO org_audit_outbox (id, org_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(
			plan.payload.id,
			plan.payload.orgId,
			JSON.stringify(plan.payload),
			plan.payload.createdAt,
		)
}

export function parseOrgAuditOutboxPayload(
	raw: string,
): OrgAuditOutboxPayload | null {
	try {
		const parsed = JSON.parse(raw) as OrgAuditOutboxPayload
		if (
			typeof parsed.id !== 'string' ||
			typeof parsed.orgId !== 'string' ||
			typeof parsed.action !== 'string' ||
			typeof parsed.result !== 'string' ||
			typeof parsed.createdAt !== 'string'
		) {
			return null
		}
		return parsed
	} catch {
		return null
	}
}

export async function deliverOrgAuditOutboxPayload(
	auditDb: D1Database,
	payload: OrgAuditOutboxPayload,
) {
	await runD1WithRetry(() =>
		auditDb
			.prepare(
				`INSERT INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				payload.id,
				payload.orgId,
				payload.actorUserId,
				payload.actorUsername,
				payload.credentialKind,
				payload.credentialId,
				payload.action,
				payload.resourceType,
				payload.resourceId,
				payload.targetUserId,
				payload.result,
				payload.detailsJson,
				payload.ipHash,
				payload.createdAt,
			)
			.run(),
	)
}

async function deleteOrgAuditOutboxRow(appDb: D1Database, outboxId: string) {
	await runD1WithRetry(() =>
		appDb
			.prepare(`DELETE FROM org_audit_outbox WHERE id = ?`)
			.bind(outboxId)
			.run(),
	)
}

/**
 * Inserts into AUDIT_DB and removes the outbox row. Returns false when AUDIT_DB
 * is unavailable so a scheduled drain can retry.
 */
export async function tryDeliverOrgAuditOutboxPlan(
	writer: OrgAuditWriter,
	plan: OrgAuditOutboxPlan,
): Promise<boolean> {
	try {
		await deliverOrgAuditOutboxPayload(writer.db, plan.payload)
		await deleteOrgAuditOutboxRow(writer.appDb, plan.outboxId)
		return true
	} catch {
		return false
	}
}

export async function enqueueOrgAuditOutbox(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
): Promise<OrgAuditOutboxPlan> {
	const plan = planOrgAuditOutbox(writer, event)
	await runD1WithRetry(() =>
		orgAuditOutboxInsertStatement(writer.appDb, plan).run(),
	)
	return plan
}

export async function commitOrgAuditOutbox(
	writer: OrgAuditWriter,
	plan: OrgAuditOutboxPlan,
) {
	await tryDeliverOrgAuditOutboxPlan(writer, plan)
}

const drainBatchSize = 50
const drainTimeBudgetMs = 10_000

export async function drainOrgAuditOutbox(input: {
	env: Pick<Env, 'APP_DB' | 'AUDIT_DB'>
	now?: Date
	clock?: () => number
	limit?: number
}) {
	const auditDb = input.env.AUDIT_DB
	if (!auditDb) {
		return {
			status: 'skipped' as const,
			reason: 'audit_db_unconfigured',
			delivered: 0,
			remaining: 0,
			errors: 0,
		}
	}
	const writer: OrgAuditWriter = {
		appDb: input.env.APP_DB,
		db: auditDb,
		actorUserId: null,
		actorUsername: null,
		credentialKind: null,
		credentialId: null,
	}
	const startedAt = (input.clock ?? Date.now)()
	const deadline = startedAt + drainTimeBudgetMs
	const batchLimit = input.limit ?? drainBatchSize
	let delivered = 0
	let errors = 0

	while ((input.clock ?? Date.now)() < deadline) {
		const rows = await input.env.APP_DB.prepare(
			`SELECT id, payload_json
			 FROM org_audit_outbox
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
			.bind(batchLimit)
			.all<{ id: string; payload_json: string }>()
		if (rows.results.length === 0) break
		for (const row of rows.results) {
			if ((input.clock ?? Date.now)() >= deadline) break
			const payload = parseOrgAuditOutboxPayload(row.payload_json)
			if (!payload) {
				errors += 1
				console.error('org_audit_outbox_invalid_payload', { id: row.id })
				continue
			}
			const ok = await tryDeliverOrgAuditOutboxPlan(writer, {
				outboxId: row.id,
				payload,
			})
			if (ok) {
				delivered += 1
			} else {
				errors += 1
			}
		}
		if (rows.results.length < batchLimit) break
	}

	const remaining = await input.env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM org_audit_outbox`,
	).first<{ count: number }>()
	return {
		status: 'ok' as const,
		delivered,
		remaining: remaining?.count ?? 0,
		errors,
	}
}
