import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	buildPermissionString,
	listAdminRolePermissionStrings,
	listRegistryPermissionStrings,
	listUserRolePermissionStrings,
	parsePermissionString,
	roleNames,
	type PermissionAccess,
	type PermissionAction,
	type PermissionEntity,
	type PermissionString,
} from './permissions.ts'

test('parsePermissionString splits action, entity, and access', () => {
	expect(parsePermissionString('read:user:own')).toEqual({
		action: 'read',
		entity: 'user',
		access: 'own',
	})
	expect(parsePermissionString('delete:role:any')).toEqual({
		action: 'delete',
		entity: 'role',
		access: 'any',
	})
})

test('permission registry and migration seed rows stay aligned', () => {
	const migrationPath = join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations/0043-rbac.sql',
	)
	const migrationSql = readFileSync(migrationPath, 'utf8').toLowerCase()
	const seededPermissions = new Set<PermissionString>()

	for (const match of migrationSql.matchAll(
		/insert or ignore into permissions \(action, entity, access\) values \('([^']+)', '([^']+)', '([^']+)'\)/g,
	)) {
		seededPermissions.add(
			buildPermissionString({
				action: match[1] as PermissionAction,
				entity: match[2] as PermissionEntity,
				access: match[3] as PermissionAccess,
			}),
		)
	}

	expect(Array.from(seededPermissions).sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	expect(migrationSql).toContain("where r.name = 'user'")
	expect(migrationSql).toContain("p.access = 'own'")
	expect(listUserRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings()
			.filter(
				(permission) => parsePermissionString(permission).access === 'own',
			)
			.sort(),
	)

	expect(migrationSql).toContain("where r.name = 'admin'")
	expect(listAdminRolePermissionStrings().sort()).toEqual(
		listRegistryPermissionStrings().sort(),
	)

	for (const roleName of roleNames) {
		expect(migrationSql).toContain(
			`insert or ignore into roles (name, description) values ('${roleName}'`,
		)
	}
})
