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
}) {
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id)
			 SELECT ?, id FROM roles WHERE name = ?`,
		)
		.bind(input.userId, input.roleName)
		.run()
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

export async function countUsersWithRole(
	db: D1Database,
	roleName: RoleName,
): Promise<number> {
	const result = await db
		.prepare(
			`SELECT COUNT(DISTINCT ur.user_id) AS count
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE r.name = ?`,
		)
		.bind(roleName)
		.first<{ count: number }>()
	return result?.count ?? 0
}
