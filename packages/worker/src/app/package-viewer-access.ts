import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

/**
 * Whether a signed-in person may open the owner view of a saved package on
 * `/@owner/<kody-id>` (details, source files, private icon). The person must
 * belong to (or hold a grant in) the org that owns the package and hold
 * `package:read` on it there, the same check as `packageGet`. The signup org
 * owner reads every package it owns; team org members read what their role,
 * teams, and grants give them. An execute-only grant lists the package but
 * does not open its source.
 */
export async function viewerCanReadSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	if (!input.viewer) return false
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	return checkPermission(
		access,
		'package:read',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

/**
 * Whether a signed-in person may change a saved package from the account UI
 * (settings, publish, delete). They must belong to the owning org and hold
 * `package:write` on the package there — the same org binding used for write
 * APIs, not signup-org equality.
 */
export async function viewerCanManageSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	if (!input.viewer) return false
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	return checkPermission(
		access,
		'package:write',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

async function effectivePackageAccess(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
}) {
	if (!input.viewer) return null
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return null
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	return { access, binding }
}

export async function viewerCanPublishSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	const resolved = await effectivePackageAccess(input)
	if (!resolved) return false
	return checkPermission(
		resolved.access,
		'package:publish',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

export async function viewerCanDeleteSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	const resolved = await effectivePackageAccess(input)
	if (!resolved) return false
	return checkPermission(
		resolved.access,
		'package:delete',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

/** Org owner role on the package's owning org (personal or team). */
export async function viewerIsSavedPackageOrgOwner(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
}): Promise<boolean> {
	const resolved = await effectivePackageAccess(input)
	return resolved?.binding.role === 'owner'
}
