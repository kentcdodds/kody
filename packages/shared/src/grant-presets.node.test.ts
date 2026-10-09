import { expect, test } from 'vitest'
import {
	isGrantablePermission,
	permissionsForGrantPreset,
	resolveGrantPermissions,
} from './grant-presets.ts'

test('use / contribute / manage expand for packages', () => {
	expect(permissionsForGrantPreset('package', 'use')).toEqual([
		'package:read',
		'package:execute',
	])
	expect(permissionsForGrantPreset('package', 'contribute')).toEqual([
		'package:read',
		'package:execute',
		'package:write',
	])
	expect(permissionsForGrantPreset('package', 'manage')).toEqual([
		'package:read',
		'package:execute',
		'package:write',
		'package:delete',
		'package:manage_access',
		'package:publish',
	])
})

test('billing and secret:read are never grantable', () => {
	expect(isGrantablePermission('org', 'billing:write')).toBe(false)
	expect(isGrantablePermission('secret', 'secret:read')).toBe(false)
	expect(isGrantablePermission('package', 'package:read')).toBe(true)
	expect(isGrantablePermission('org', 'package:create')).toBe(true)
})

test('resolveGrantPermissions rejects a non-grantable advanced list', () => {
	expect(() =>
		resolveGrantPermissions({
			resourceType: 'package',
			preset: null,
			permissions: ['billing:write'],
		}),
	).toThrow(/cannot be granted/)
})
