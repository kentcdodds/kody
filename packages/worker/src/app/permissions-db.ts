import { type PermissionString, type RoleName } from '#app/permissions.ts'

type PermissionRow = {
	role_name: string
	action: string
	entity: string
	access: string
}

function formatPermissionString(row: PermissionRow): PermissionString {
	return `${row.action}:${row.entity}:${row.access}` as PermissionString
}

export async function getUserRolesAndPermissions(
	db: D1Database,
	userId: number,
): Promise<{ roles: Array<RoleName>; permissions: Array<PermissionString> }> {
	const result = await db
		.prepare(
			`SELECT DISTINCT r.name AS role_name, p.action, p.entity, p.access
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 INNER JOIN role_permissions rp ON rp.role_id = r.id
			 INNER JOIN permissions p ON p.id = rp.permission_id
			 WHERE ur.user_id = ?`,
		)
		.bind(userId)
		.all<PermissionRow>()

	const roleSet = new Set<RoleName>()
	const permissionSet = new Set<PermissionString>()
	for (const row of result.results ?? []) {
		if (row.role_name === 'user' || row.role_name === 'admin') {
			roleSet.add(row.role_name)
		}
		permissionSet.add(formatPermissionString(row))
	}

	return {
		roles: Array.from(roleSet).sort(),
		permissions: Array.from(permissionSet).sort(),
	}
}

export async function assignUserRole(input: {
	db: D1Database
	userId: number
	roleName: RoleName
}): Promise<{ assigned: boolean }> {
	const result = await input.db
		.prepare(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id)
			 SELECT ?, id FROM roles WHERE name = ?`,
		)
		.bind(input.userId, input.roleName)
		.run()
	return { assigned: (result.meta?.changes ?? 0) > 0 }
}

export async function removeUserRole(input: {
	db: D1Database
	userId: number
	roleName: RoleName
}) {
	await input.db
		.prepare(
			`DELETE FROM user_roles
			 WHERE user_id = ?
			   AND role_id = (SELECT id FROM roles WHERE name = ?)`,
		)
		.bind(input.userId, input.roleName)
		.run()
}

/**
 * Removes the admin role from a user only while at least one other admin
 * remains. The count check lives inside the DELETE statement so concurrent
 * removals cannot both pass a stale pre-check and leave zero admins.
 */
export async function removeAdminRolePreservingLastAdmin(input: {
	db: D1Database
	userId: number
}): Promise<{ removed: boolean }> {
	const result = await input.db
		.prepare(
			`DELETE FROM user_roles
			 WHERE user_id = ?
			   AND role_id = (SELECT id FROM roles WHERE name = 'admin')
			   AND (SELECT COUNT(DISTINCT ur.user_id)
			        FROM user_roles ur
			        INNER JOIN roles r ON r.id = ur.role_id
			        WHERE r.name = 'admin') > 1`,
		)
		.bind(input.userId)
		.run()
	return { removed: (result.meta?.changes ?? 0) > 0 }
}
