/**
 * Org RBAC vocabulary: `resource-type:action` strings. There is no implied
 * hierarchy (`package:execute` without `package:read` is valid). Site-admin
 * roles (`universal/permissions.ts`) are a separate system and never appear
 * here. See docs/contributing/architecture/authorization.md.
 */

const resourceActions = {
	package: ['read', 'execute', 'write', 'delete', 'publish', 'manage_access'],
	app: ['read', 'execute', 'write', 'delete', 'manage_access'],
	job: ['read', 'execute', 'write', 'delete', 'manage_access'],
	// `secret:read` (reveal a value) is reserved: no surface checks it yet.
	secret: ['use', 'read', 'write', 'delete', 'manage_access'],
	integration: ['use', 'read', 'write', 'delete', 'manage_access'],
	memory: ['read', 'write', 'delete', 'manage_access'],
	email: ['read', 'send', 'write', 'delete', 'manage_access'],
} as const

type OrgResourceType = keyof typeof resourceActions

const orgResourceTypes = Object.keys(resourceActions) as Array<OrgResourceType>

type ResourcePermission = {
	[Type in OrgResourceType]: `${Type}:${(typeof resourceActions)[Type][number]}`
}[OrgResourceType]

type CreatePermission = `${OrgResourceType}:create`

const orgLevelPermissionList = [
	'org:read',
	'org:write',
	'org:delete',
	'org:execute',
	'search:read',
	'member:read',
	'member:write',
	'member:delete',
	'team:read',
	'team:write',
	'team:delete',
	'billing:read',
	'billing:write',
	'audit:read',
	'token:read',
	'token:delete',
] as const

export type OrgPermission =
	| ResourcePermission
	| CreatePermission
	| (typeof orgLevelPermissionList)[number]

const orgPermissions: ReadonlyArray<OrgPermission> = [
	...orgResourceTypes.flatMap((type) =>
		resourceActions[type].map(
			(action) => `${type}:${action}` as ResourcePermission,
		),
	),
	...orgResourceTypes.map((type) => `${type}:create` as CreatePermission),
	...orgLevelPermissionList,
]

const orgPermissionSet: ReadonlySet<string> = new Set(orgPermissions)

export function isOrgPermission(value: unknown): value is OrgPermission {
	return typeof value === 'string' && orgPermissionSet.has(value)
}
