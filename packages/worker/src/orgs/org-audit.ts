import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'

export const orgAuditEventResults = ['success', 'failure', 'denied'] as const

export type OrgAuditEventResult = (typeof orgAuditEventResults)[number]

export type LogOrgAuditEventInput = {
	env?: Env
	db?: D1Database | null | undefined
	orgId: string
	action: string
	result: OrgAuditEventResult
	actorUserId?: string | null
	actorUsername?: string | null
	credentialKind?: string | null
	credentialId?: string | null
	resourceType?: string | null
	resourceId?: string | null
	targetUserId?: string | null
	details?: Record<string, unknown>
	detailsJson?: string | null
	ipHash?: string | null
	createdAt?: string
}

function resolveAuditDb(input: LogOrgAuditEventInput): D1Database {
	if (input.db) return input.db
	if (input.env?.AUDIT_DB) return input.env.AUDIT_DB
	if (input.env) {
		const fromEnv = auditDatabaseFromEnv(input.env)
		if (fromEnv) return fromEnv
	}
	throw new Error('AUDIT_DB binding is not configured.')
}

function serializeDetails(input: LogOrgAuditEventInput): string | null {
	if (input.detailsJson !== undefined) return input.detailsJson
	if (input.details !== undefined) return JSON.stringify(input.details)
	return null
}

export function auditDatabaseFromEnvOrThrow(env: Env): D1Database {
	return resolveAuditDb({ env, orgId: '', action: '', result: 'success' })
}

export async function logOrgAuditEvent(input: LogOrgAuditEventInput) {
	const db = resolveAuditDb(input)
	const createdAt = input.createdAt ?? new Date().toISOString()
	await runD1WithRetry(() =>
		db
			.prepare(
				`INSERT INTO org_audit_events (
					id, org_id, actor_user_id, actor_username, credential_kind,
					credential_id, action, resource_type, resource_id, target_user_id,
					result, details_json, ip_hash, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				input.orgId,
				input.actorUserId ?? null,
				input.actorUsername ?? null,
				input.credentialKind ?? null,
				input.credentialId ?? null,
				input.action,
				input.resourceType ?? null,
				input.resourceId ?? null,
				input.targetUserId ?? null,
				input.result,
				serializeDetails(input),
				input.ipHash ?? null,
				createdAt,
			)
			.run(),
	)
}

export async function redactOrgAuditActorIdsForDeletedUser(input: {
	env: Env
	userId: string
}) {
	const db = auditDatabaseFromEnvOrThrow(input.env)
	await runD1WithRetry(() =>
		db
			.prepare(
				`UPDATE org_audit_events
				SET actor_user_id = 'deleted-user'
				WHERE actor_user_id = ?`,
			)
			.bind(input.userId)
			.run(),
	)
}

/** Who is acting and where org audit rows go; built once per request. */
export type OrgAuditWriter = {
	db: D1Database
	actorUserId: string | null
	actorUsername: string | null
	credentialKind: string | null
	credentialId: string | null
}

export function orgAuditWriterFromRequest(
	env: Env,
	request: RequestContext,
): OrgAuditWriter {
	return {
		db: auditDatabaseFromEnvOrThrow(env),
		actorUserId: request.actor?.userId ?? null,
		actorUsername: request.actor?.username ?? null,
		credentialKind: request.credential.kind,
		credentialId: request.credential.id,
	}
}

export function orgAuditWriterForPerson(
	env: Env,
	actor: { userId: string | null; username?: string | null },
): OrgAuditWriter {
	return {
		db: auditDatabaseFromEnvOrThrow(env),
		actorUserId: actor.userId,
		actorUsername: actor.username ?? null,
		credentialKind: null,
		credentialId: null,
	}
}

export async function recordOrgAuditEvent(
	writer: OrgAuditWriter,
	event: {
		orgId: string
		action: string
		resourceType?: string | null
		resourceId?: string | null
		targetUserId?: string | null
		details?: Record<string, unknown>
	},
) {
	await logOrgAuditEvent({
		db: writer.db,
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
		details: event.details,
	})
}
