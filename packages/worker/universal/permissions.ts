export const permissionActions = ['create', 'read', 'update', 'delete'] as const
export const permissionEntities = ['user', 'role'] as const
export const permissionAccesses = ['own', 'any'] as const

export type PermissionAction = (typeof permissionActions)[number]
export type PermissionEntity = (typeof permissionEntities)[number]
export type PermissionAccess = (typeof permissionAccesses)[number]

export type PermissionString =
	`${PermissionAction}:${PermissionEntity}:${PermissionAccess}`

export function parsePermissionString(value: PermissionString) {
	const [action, entity, access] = value.split(':')
	return { action, entity, access } as {
		action: PermissionAction
		entity: PermissionEntity
		access: PermissionAccess
	}
}

export function userHasPermission(
	user: { permissions: Array<PermissionString> },
	permission: PermissionString,
): boolean {
	return user.permissions.includes(permission)
}

export function userHasRole(
	user: { roles: Array<RoleName> },
	role: RoleName,
): boolean {
	return user.roles.includes(role)
}

export const roleNames = ['user', 'admin'] as const
export type RoleName = (typeof roleNames)[number]

export function buildPermissionString(input: {
	action: PermissionAction
	entity: PermissionEntity
	access: PermissionAccess
}): PermissionString {
	return `${input.action}:${input.entity}:${input.access}`
}

export function listRegistryPermissionStrings(): Array<PermissionString> {
	const permissions: Array<PermissionString> = []
	for (const action of permissionActions) {
		for (const entity of permissionEntities) {
			for (const access of permissionAccesses) {
				permissions.push(buildPermissionString({ action, entity, access }))
			}
		}
	}
	return permissions
}

export function listUserRolePermissionStrings(): Array<PermissionString> {
	const permissions: Array<PermissionString> = []
	for (const action of permissionActions) {
		for (const entity of permissionEntities) {
			permissions.push(buildPermissionString({ action, entity, access: 'own' }))
		}
	}
	return permissions
}

export function listAdminRolePermissionStrings(): Array<PermissionString> {
	return listRegistryPermissionStrings()
}
