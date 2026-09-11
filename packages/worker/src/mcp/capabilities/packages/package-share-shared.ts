import { z } from 'zod'
import {
	type PackageShareGrantView,
	packageShareTrustLevels,
} from '#worker/package-registry/share-grants.ts'
import { packageShareRoles } from '#worker/package-registry/share-rbac.ts'

export const packageShareTrustLevelSchema = z
	.enum(packageShareTrustLevels)
	.describe(
		'Publish trust. pin (default, safer) accepts the current published commit only and fails closed if the owner publishes ahead until you approve. follow auto-accepts future owner publishes.',
	)

export const packageShareGrantSchema = z.object({
	grant_id: z.string(),
	package_id: z.string(),
	package_name: z.string(),
	package_kody_id: z.string(),
	owner_user_id: z.string(),
	owner_username: z.string(),
	invitee_email: z.string().nullable(),
	invitee_username: z.string().nullable(),
	grantee_user_id: z.string().nullable(),
	grantee_username: z.string().nullable(),
	status: z.enum(['pending', 'accepted', 'revoked', 'left']),
	role: z.enum(packageShareRoles),
	trust_level: z.enum(packageShareTrustLevels).nullable(),
	accepted_published_commit: z.string().nullable(),
	published_commit: z.string().nullable(),
	pin_ahead: z.boolean(),
	approve_changes_path: z.string().nullable(),
	invited_at: z.string(),
	accepted_at: z.string().nullable(),
	revoked_at: z.string().nullable(),
	left_at: z.string().nullable(),
	last_acknowledged_at: z.string().nullable(),
})

export function toPackageShareGrantPayload(view: PackageShareGrantView) {
	return {
		grant_id: view.id,
		package_id: view.packageId,
		package_name: view.packageName,
		package_kody_id: view.packageKodyId,
		owner_user_id: view.ownerUserId,
		owner_username: view.ownerUsername,
		invitee_email: view.inviteeEmail,
		invitee_username: view.inviteeUsername,
		grantee_user_id: view.granteeUserId,
		grantee_username: view.granteeUsername,
		status: view.status,
		role: view.role,
		trust_level: view.trustLevel,
		accepted_published_commit: view.acceptedPublishedCommit,
		published_commit: view.publishedCommit,
		pin_ahead: view.pinAhead,
		approve_changes_path: view.approveChangesPath,
		invited_at: view.invitedAt,
		accepted_at: view.acceptedAt,
		revoked_at: view.revokedAt,
		left_at: view.leftAt,
		last_acknowledged_at: view.lastAcknowledgedAt,
	}
}
