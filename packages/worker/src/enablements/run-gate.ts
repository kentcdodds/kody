/**
 * The one gate every trigger passes before it runs (credentials plan v4,
 * section 3.3). A trigger runs once per on enablement, as that enablement's
 * enabler, and only while the enabler still has access. A trigger nobody
 * turned on runs nothing: there is no run without a person.
 *
 * Lost access pauses the enablement and its events are dropped. The next
 * event checks again and resumes it once access is back. There is never a
 * fallback to another person, another credential, or Owner.
 */
import {
	isOrgPermission,
	isOrgGrantResourceType,
	orgPermissions,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import { type PersonId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	type EffectivePermissions,
	type OrgResource,
} from '#worker/authorization/authorize.ts'
import {
	findCredentialIdsByLegacyName,
	getOrgCredential,
	isLegacyNamedCredentialTarget,
} from '#worker/credentials/credential-ids.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	deriveRequestContext,
	type EnablementRun,
} from '#worker/request-context/request-context.ts'
import {
	getSecretProviderBinding,
	normalizeProviderId,
} from '#mcp/secrets/secret-providers/service.ts'
import { vaultPauseResourceType } from './pause-on-denial.ts'
import {
	listEnablementsForInstance,
	pauseEnablement,
	resumeEnablement,
	type EnablementPauseInput,
} from './repo.ts'
import { type EnablementRecord, type EnablementTriggerKind } from './types.ts'

export type EnablementTrigger = {
	kind: EnablementTriggerKind
	/** Job id, subscribing package id, or webhook endpoint id. */
	instanceId: string
	/** The topic, for subscriptions. */
	triggerName?: string
}

export type EnablementSkipReason =
	/** Paused before this event, or paused by this event's access check. */
	| 'paused'
	/** Not the enabler this event may reach (run-raised and emailed events). */
	| 'other_enabler'
	/** The event is about something the enabler cannot see. */
	| 'audience'

export type EnablementSkip = {
	enablementId: string
	enablerUserId: PersonId
	reason: EnablementSkipReason
}

export type EnablementRunPlan = {
	runs: Array<EnablementRun>
	skipped: Array<EnablementSkip>
}

/**
 * What an org-wide event is about, for the audience rule. `resource: null`
 * is something only Owners see (an ad hoc run with no package or job).
 */
export type EnablementAudience = {
	resource: Pick<OrgResource, 'type' | 'id'> | null
}

/**
 * Whether an enabler with `access` may receive an event about `audience`:
 * like `canSeeResource`, any permission on the resource counts, since there
 * is no implied hierarchy (write-only still sees it).
 */
export function enablerCanSee(
	access: EffectivePermissions,
	audience: EnablementAudience,
): boolean {
	if (access.isOwner) return true
	if (!audience.resource) return false
	const resource: OrgResource = { ...audience.resource, orgId: access.orgId }
	const families: ReadonlyArray<string> =
		resource.type === 'credential' ? ['secret', 'integration'] : [resource.type]
	return orgPermissions.some((permission) => {
		const [family, action] = permission.split(':')
		return (
			families.includes(family ?? '') &&
			action !== 'create' &&
			checkPermission(access, permission, resource).allowed
		)
	})
}

type EnablerRow = { stable_user_id: string; username: string }

async function loadLiveEnabler(db: D1Database, userId: string) {
	return await db
		.prepare(
			`SELECT stable_user_id, username FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL
			   AND deleting_at IS NULL AND suspended_at IS NULL`,
		)
		.bind(userId)
		.first<EnablerRow>()
}

/**
 * What a credential pause waits on. The credential's stable id while it is
 * still live; once soft-deleted, its name resolves now (by name), so a
 * grant on a deleted credential never resumes the enablement. A vault
 * binding, or an id whose row is gone (vault bindings are hard-deleted), has
 * no name lane. A vault that had no binding resolves its provider id to the
 * live binding now. A name that still names nothing only Owners and org-wide
 * holders pass, and a name that names two integrations resumes on Use of
 * either.
 */
async function storedPauseResource(
	db: D1Database,
	enablement: EnablementRecord,
): Promise<{
	permission: OrgPermission
	resources: Array<OrgResource>
} | null> {
	const pause = enablement.pause
	if (pause?.reason !== 'credential_access') return null
	if (!isOrgPermission(pause.permission)) return null
	if (pause.credentialId) {
		const credential = await getOrgCredential(
			db,
			enablement.orgId,
			pause.credentialId,
		)
		if (!credential || credential.live || credential.kind === 'vault') {
			return {
				permission: pause.permission,
				resources: [
					{
						type: 'credential',
						id: credential?.live ? pause.credentialId : '',
						orgId: enablement.orgId,
					},
				],
			}
		}
	}
	if (!pause.resourceId) return null
	if (pause.resourceType === vaultPauseResourceType) {
		const binding = await getSecretProviderBinding(db, {
			userId: enablement.orgId,
			providerId: normalizeProviderId(pause.resourceId),
		})
		return {
			permission: pause.permission,
			resources: [
				{
					type: 'credential',
					id: binding?.credentialId ?? '',
					orgId: enablement.orgId,
				},
			],
		}
	}
	if (isLegacyNamedCredentialTarget(pause.resourceType)) {
		const credentialIds = await findCredentialIdsByLegacyName(
			db,
			enablement.orgId,
			{ type: pause.resourceType, name: pause.resourceId },
		)
		return {
			permission: pause.permission,
			resources: (credentialIds.length > 0 ? credentialIds : ['']).map(
				(id) => ({ type: 'credential', id, orgId: enablement.orgId }),
			),
		}
	}
	if (!isOrgGrantResourceType(pause.resourceType)) return null
	return {
		permission: pause.permission,
		resources: [
			{
				type: pause.resourceType,
				id: pause.resourceId,
				orgId: enablement.orgId,
			},
		],
	}
}

type AccessCheck =
	| { ok: true; run: EnablementRun; access: EffectivePermissions }
	| { ok: false; pause: EnablementPauseInput | null }

async function checkEnablerAccess(input: {
	env: Env
	enablement: EnablementRecord
	packageResource: OrgResource
}): Promise<AccessCheck> {
	const { enablement } = input
	const db = input.env.APP_DB
	const enabler = await loadLiveEnabler(db, enablement.enablerUserId)
	const binding = enabler
		? await loadOrgBindingForOrg(db, enablement.enablerUserId, enablement.orgId)
		: null
	if (!enabler || !binding) {
		return { ok: false, pause: { reason: 'org_access' } }
	}
	const run: EnablementRun = {
		id: enablement.id,
		enabler: {
			userId: enablement.enablerUserId,
			username: enabler.username,
		},
		role: binding.role,
	}
	const request = deriveRequestContext({
		user: run.enabler,
		source: {
			kind: 'platform-event',
			sourceId: enablement.id,
			enablement: run,
		},
		orgBinding: binding,
	})
	const access = await computeEffectivePermissions({ env: input.env, request })
	const packageDecision = checkPermission(
		access,
		'package:execute',
		input.packageResource,
	)
	if (!packageDecision.allowed) {
		return {
			ok: false,
			pause: {
				reason: 'package_access',
				permission: 'package:execute',
				resourceType: input.packageResource.type,
				resourceId: input.packageResource.id,
			},
		}
	}
	const stored = await storedPauseResource(db, enablement)
	if (stored) {
		// Still blocked on the same credential: stay paused as is.
		const allowed = stored.resources.some(
			(resource) =>
				checkPermission(access, stored.permission, resource).allowed,
		)
		if (!allowed) return { ok: false, pause: null }
	}
	return { ok: true, run, access }
}

/**
 * Decide which enablements of `trigger` run for one event, pausing the ones
 * whose enabler lost access and resuming the ones whose access is back.
 *
 * - `onlyEnablerId`: events raised by a run, and member-sent email, reach
 *   only that person's enablements.
 * - `audience`: the audience rule for org-wide topics. An enabler who cannot
 *   see what the event is about is skipped without pausing.
 */
export async function planEnablementRuns(input: {
	env: Env
	orgId: string
	packageId: string
	trigger: EnablementTrigger
	onlyEnablerId?: string | null
	audience?: EnablementAudience | null
}): Promise<EnablementRunPlan> {
	const db = input.env.APP_DB
	const enablements = await listEnablementsForInstance({
		db,
		orgId: input.orgId,
		triggerKind: input.trigger.kind,
		instanceId: input.trigger.instanceId,
		triggerName: input.trigger.triggerName,
	})
	const runs: Array<EnablementRun> = []
	const skipped: Array<EnablementSkip> = []
	for (const enablement of enablements) {
		const skip = (reason: EnablementSkipReason) =>
			skipped.push({
				enablementId: enablement.id,
				enablerUserId: enablement.enablerUserId,
				reason,
			})
		if (
			input.onlyEnablerId &&
			String(enablement.enablerUserId) !== String(input.onlyEnablerId)
		) {
			skip('other_enabler')
			continue
		}
		const check = await checkEnablerAccess({
			env: input.env,
			enablement,
			packageResource: {
				type: 'package',
				id: input.packageId,
				orgId: enablement.orgId,
			},
		})
		if (!check.ok) {
			if (check.pause && enablement.state === 'on') {
				await pauseEnablement({
					db,
					orgId: input.orgId,
					id: enablement.id,
					pause: check.pause,
				})
			}
			skip('paused')
			continue
		}
		if (enablement.state === 'paused') {
			await resumeEnablement({ db, orgId: input.orgId, id: enablement.id })
		}
		if (input.audience && !enablerCanSee(check.access, input.audience)) {
			skip('audience')
			continue
		}
		runs.push(check.run)
	}
	return { runs, skipped }
}
