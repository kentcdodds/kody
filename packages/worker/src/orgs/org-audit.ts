import * as Sentry from '@sentry/cloudflare'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import {
	commitOrgAuditOutbox,
	enqueueOrgAuditOutbox,
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
} from './org-audit-outbox.ts'

export const orgAuditEventResults = ['success', 'failure', 'denied'] as const

export type OrgAuditEventResult = (typeof orgAuditEventResults)[number]

export type LogOrgAuditEventInput = {
	env?: Env
	db?: D1Database | null | undefined
	id?: string
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
				input.id ?? crypto.randomUUID(),
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

export type { OrgAuditWriter } from './org-audit-outbox.ts'

export function orgAuditWriterFromRequest(
	env: Env,
	request: RequestContext,
): OrgAuditWriter {
	return {
		appDb: env.APP_DB,
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
		appDb: env.APP_DB,
		db: auditDatabaseFromEnvOrThrow(env),
		actorUserId: actor.userId,
		actorUsername: actor.username ?? null,
		credentialKind: null,
		credentialId: null,
	}
}

/**
 * Records an access change that has already committed to APP_DB. The outbox row
 * on APP_DB is durable; AUDIT_DB delivery is best-effort inline with scheduled
 * drain as backup. Outbox enqueue failures are reported loudly but never
 * rethrown.
 */
export type {
	OrgAuditOutboxEvent,
	OrgAuditOutboxPlan,
} from './org-audit-outbox.ts'
export {
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
	commitOrgAuditOutbox,
} from './org-audit-outbox.ts'

export async function recordOrgAuditEvent(
	writer: OrgAuditWriter,
	event: OrgAuditOutboxEvent,
) {
	try {
		const plan = await enqueueOrgAuditOutbox(writer, event)
		await commitOrgAuditOutbox(writer, plan)
	} catch (error) {
		console.error('Failed to enqueue org audit outbox row:', {
			orgId: event.orgId,
			action: event.action,
			resourceType: event.resourceType ?? null,
			resourceId: event.resourceId ?? null,
			error,
		})
		Sentry.withScope((scope) => {
			scope.setTag('org_audit.action', event.action)
			scope.setContext('org_audit', {
				orgId: event.orgId,
				action: event.action,
				resourceType: event.resourceType ?? null,
				resourceId: event.resourceId ?? null,
			})
			Sentry.captureException(error)
		})
	}
}
