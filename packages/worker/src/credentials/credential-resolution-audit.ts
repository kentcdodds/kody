import * as Sentry from '@sentry/cloudflare'
import { waitUntil } from 'cloudflare:workers'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { IntegrationPackageAccessDeniedError } from '#worker/integrations/package-access.ts'
import { McpServerPackageAccessDeniedError } from '#worker/mcp-client/package-access.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { IntegrationHostNotAllowedError } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import { PackageSecretAccessDeniedError } from '#mcp/secrets/package-access.ts'
import {
	SecretProviderGrantDeniedError,
	SecretProviderHostDeniedError,
} from '#mcp/secrets/secret-providers/errors.ts'
import { type PackageStamp } from './package-stamp.ts'

export const credentialResolveAuditAction = 'credential.resolve'

/**
 * Which credential a resolution is for. `resourceKey` is today's resource key
 * (secret name, integration or MCP server name, vault provider id); stable
 * credential ids replace it once credentials have them. Fetch uses record
 * `details.host`, the host the value is sent to, so a review can compare
 * declared and used hosts.
 */
export type CredentialAuditSubject = {
	use: string
	resourceType: 'secret' | 'secret-provider' | 'integration' | 'mcp-server'
	resourceKey: string
	details?: Record<string, string | null>
}

export type CredentialResolutionOutcome =
	| { result: 'success' }
	| { result: 'failure' | 'denied'; reason: string }

export function credentialResolutionOutcomeForError(
	error: unknown,
): CredentialResolutionOutcome {
	if (error instanceof AuthorizationError) {
		return { result: 'denied', reason: error.code }
	}
	if (
		error instanceof PackageSecretAccessDeniedError ||
		error instanceof IntegrationPackageAccessDeniedError ||
		error instanceof McpServerPackageAccessDeniedError ||
		error instanceof SecretProviderGrantDeniedError ||
		error instanceof SecretHostNotApprovedError ||
		error instanceof SecretProviderHostDeniedError ||
		error instanceof IntegrationHostNotAllowedError
	) {
		return { result: 'denied', reason: error.name }
	}
	return {
		result: 'failure',
		reason: error instanceof Error ? error.name : 'unknown',
	}
}

function actorKind(actor: RequestContext | null) {
	if (!actor) return 'platform'
	return actor.actor ? 'person' : 'automation'
}

/**
 * One `org_audit_events` row per credential resolution, written after the
 * response path via `waitUntil`. The row names the credential and who asked,
 * never its value. A failed write is logged and reported, never thrown.
 */
export function scheduleCredentialResolutionAudit(input: {
	env: Env
	orgId: OwnerId
	actor: RequestContext | null
	packageStamp: PackageStamp | null | undefined
	subject: CredentialAuditSubject
	outcome: CredentialResolutionOutcome
}) {
	const db = auditDatabaseFromEnv(input.env)
	// `undefined` is the generic-test opt-out (see `auditDatabaseFromEnv`).
	if (db === undefined) return
	const { subject, outcome } = input
	const request = input.actor
	const event = {
		orgId: input.orgId,
		action: credentialResolveAuditAction,
		resourceType: subject.resourceType,
		resourceId: subject.resourceKey,
		result: outcome.result,
	}
	waitUntil(
		(async () => {
			if (!db) throw new Error('AUDIT_DB binding is not configured.')
			await logOrgAuditEvent({
				db,
				...event,
				actorUserId: request?.actor?.userId ?? null,
				actorUsername: request?.actor?.username ?? null,
				credentialKind: request?.credential.kind ?? null,
				credentialId: request?.credential.id ?? null,
				details: {
					use: subject.use,
					actorKind: actorKind(request),
					ownerKind: 'org',
					packageStampKind: input.packageStamp?.kind ?? 'none',
					packageId: input.packageStamp?.packageId ?? null,
					...(outcome.result === 'success' ? {} : { reason: outcome.reason }),
					...subject.details,
				},
			})
		})().catch((error: unknown) => {
			console.error('Failed to record credential resolution audit event:', {
				...event,
				error,
			})
			Sentry.withScope((scope) => {
				scope.setTag('org_audit.action', event.action)
				scope.setContext('org_audit', event)
				Sentry.captureException(error)
			})
		}),
	)
}
