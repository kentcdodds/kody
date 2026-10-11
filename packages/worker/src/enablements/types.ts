import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * An enablement is the only way a trigger runs on its own (credentials plan
 * v4, section 3.3). Each run of an enablement acts as its enabler.
 *
 * - `cron`: a scheduled job. `instanceId` is the job id.
 * - `subscription`: a package subscription topic, inbound email included.
 *   `instanceId` is the subscribing package id; `triggerName` is the topic.
 * - `webhook`: a minted webhook endpoint. `instanceId` is the endpoint id.
 */
export const enablementTriggerKinds = [
	'cron',
	'subscription',
	'webhook',
] as const

export type EnablementTriggerKind = (typeof enablementTriggerKinds)[number]

export type EnablementState = 'on' | 'paused' | 'off'

/**
 * Why an enablement paused. A paused enablement drops its events and resumes
 * by itself once the cause clears (checked on the next event).
 *
 * - `org_access`: the enabler no longer has access to the org.
 * - `package_access`: the enabler lost `package:execute` on the package.
 * - `credential_access`: a credential the run needed was denied to the
 *   enabler (`pausedPermission` on the stored resource).
 */
export const enablementPausedReasons = [
	'org_access',
	'package_access',
	'credential_access',
] as const

export type EnablementPausedReason = (typeof enablementPausedReasons)[number]

export type EnablementPause = {
	reason: EnablementPausedReason
	permission: string | null
	/** For a credential, its permission family (`secret` or `integration`). */
	resourceType: string | null
	/** For a credential, its name: what people and the run know it by. */
	resourceId: string | null
	/** The denied credential's stable id; null when it did not exist. */
	credentialId: string | null
	pausedAt: string
}

export type EnablementOrigin = 'enabled' | 'migrated'

export type EnablementRecord = {
	id: string
	orgId: OwnerId
	packageId: string | null
	triggerKind: EnablementTriggerKind
	triggerName: string
	instanceId: string
	enablerUserId: PersonId
	state: EnablementState
	pause: EnablementPause | null
	origin: EnablementOrigin
	enabledAt: string
	disabledAt: string | null
	updatedAt: string
}

export type EnablementOrgMigrationState = 'legacy' | 'notified' | 'migrated'
