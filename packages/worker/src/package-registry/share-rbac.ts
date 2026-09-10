/**
 * Per-package share-grant RBAC. v1 ships one role (`use`) that can read
 * source and invoke. Collaborator / write levels add permissions here later
 * without changing the grant table's role column contract beyond extending
 * the CHECK list.
 */

export const packageShareRoles = ['use'] as const

export type PackageShareRole = (typeof packageShareRoles)[number]

export const packageSharePermissions = [
	'read_source',
	'invoke',
	'write_source',
	'publish',
	'create_jobs',
	'create_apps',
	'create_webhooks',
	'create_subscriptions',
] as const

export type PackageSharePermission = (typeof packageSharePermissions)[number]

const packageShareRolePermissionMap = {
	use: ['read_source', 'invoke'],
} as const satisfies Record<
	PackageShareRole,
	ReadonlyArray<PackageSharePermission>
>

export const defaultPackageShareRole: PackageShareRole = 'use'

export function isPackageShareRole(value: string): value is PackageShareRole {
	return (packageShareRoles as ReadonlyArray<string>).includes(value)
}

export function packageShareRoleAllows(
	role: PackageShareRole,
	permission: PackageSharePermission,
) {
	return (
		packageShareRolePermissionMap[role] as ReadonlyArray<string>
	).includes(permission)
}

export function listPackageShareRolePermissions(role: PackageShareRole) {
	return packageShareRolePermissionMap[role]
}
