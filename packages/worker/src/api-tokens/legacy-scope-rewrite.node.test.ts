import { expect, test } from 'vitest'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	isLegacyApiTokenScope,
	legacyApiTokenScopeMap,
	rewriteLegacyApiTokenScopes,
} from './legacy-scope-rewrite.ts'

test('rewrites each §5.3 legacy scope to the fixed org-permission set', () => {
	expect(rewriteLegacyApiTokenScopes(['account:read'])).toEqual([
		'billing:read',
		'member:read',
		'org:read',
	])
	expect(rewriteLegacyApiTokenScopes(['account:write'])).toEqual([
		'billing:read',
		'billing:write',
		'member:read',
		'org:read',
		'org:write',
	])
	expect(rewriteLegacyApiTokenScopes(['memories:read'])).toEqual([
		'memory:read',
	])
	expect(rewriteLegacyApiTokenScopes(['memories:write'])).toEqual([
		'memory:create',
		'memory:delete',
		'memory:read',
		'memory:write',
	])
	expect(rewriteLegacyApiTokenScopes(['secrets:read'])).toEqual(['secret:use'])
	expect(rewriteLegacyApiTokenScopes(['secrets:write'])).toEqual([
		'secret:create',
		'secret:delete',
		'secret:use',
		'secret:write',
	])
	expect(rewriteLegacyApiTokenScopes(['secrets:write'])).not.toContain(
		'secret:read',
	)
	expect(rewriteLegacyApiTokenScopes(['packages:read'])).toEqual([
		'app:execute',
		'app:read',
		'package:execute',
		'package:read',
	])
	expect(rewriteLegacyApiTokenScopes(['packages:write'])).toEqual([
		'app:delete',
		'app:execute',
		'app:read',
		'app:write',
		'package:create',
		'package:delete',
		'package:execute',
		'package:manage_access',
		'package:read',
		'package:write',
	])
	expect(rewriteLegacyApiTokenScopes(['repos:read'])).toEqual(['package:read'])
	expect(rewriteLegacyApiTokenScopes(['repos:write'])).toEqual([
		'package:read',
		'package:write',
	])
	expect(rewriteLegacyApiTokenScopes(['jobs:read'])).toEqual(['job:read'])
	expect(rewriteLegacyApiTokenScopes(['jobs:write'])).toEqual([
		'job:create',
		'job:delete',
		'job:execute',
		'job:read',
		'job:write',
	])
	expect(rewriteLegacyApiTokenScopes(['webhooks:read'])).toEqual([
		'package:read',
	])
	expect(rewriteLegacyApiTokenScopes(['webhooks:write'])).toEqual([
		'package:read',
		'package:write',
	])
	expect(rewriteLegacyApiTokenScopes(['email:read'])).toEqual(['email:read'])
	expect(rewriteLegacyApiTokenScopes(['email:write'])).toEqual([
		'email:create',
		'email:delete',
		'email:read',
		'email:send',
		'email:write',
	])
	expect(rewriteLegacyApiTokenScopes(['integrations:read'])).toEqual([
		'integration:read',
	])
	expect(rewriteLegacyApiTokenScopes(['mcp-servers:read'])).toEqual([
		'integration:read',
	])
	expect(rewriteLegacyApiTokenScopes(['integrations:write'])).toEqual([
		'integration:create',
		'integration:delete',
		'integration:read',
		'integration:use',
		'integration:write',
	])
	expect(rewriteLegacyApiTokenScopes(['mcp-servers:write'])).toEqual(
		rewriteLegacyApiTokenScopes(['integrations:write']),
	)
	expect(rewriteLegacyApiTokenScopes(['runs:read'])).toEqual([
		'job:read',
		'package:read',
	])
	expect(rewriteLegacyApiTokenScopes(['runs:write'])).toEqual([
		'job:execute',
		'job:read',
		'package:read',
	])
	expect(rewriteLegacyApiTokenScopes(['storage:read'])).toEqual([
		'package:read',
	])
	expect(rewriteLegacyApiTokenScopes(['storage:write'])).toEqual([
		'package:read',
		'package:write',
	])
	expect(rewriteLegacyApiTokenScopes(['community:read'])).toEqual(['org:read'])
	expect(rewriteLegacyApiTokenScopes(['community:write'])).toEqual([
		'org:read',
		'package:publish',
	])
	expect(rewriteLegacyApiTokenScopes(['tokens:read'])).toEqual(['token:read'])
	expect(rewriteLegacyApiTokenScopes(['tokens:write'])).toEqual([
		'token:delete',
		'token:read',
	])
	expect(rewriteLegacyApiTokenScopes(['search:read'])).toEqual(['search:read'])
	expect(rewriteLegacyApiTokenScopes(['local-execute'])).toEqual([
		'org:execute',
	])
})

test('dedupes overlapping expansions, keeps org permissions, and sorts', () => {
	expect(
		rewriteLegacyApiTokenScopes([
			'account:read',
			'community:read',
			'org:execute',
			'account:read',
		]),
	).toEqual(['billing:read', 'member:read', 'org:execute', 'org:read'])
})

test('throws on unknown scopes', () => {
	expect(() => rewriteLegacyApiTokenScopes(['packages:admin'])).toThrow(
		/Unknown legacy API token scope\(s\): packages:admin/,
	)
	expect(() =>
		rewriteLegacyApiTokenScopes(['account:read', 'not-a-scope']),
	).toThrow(/not-a-scope/)
})

test('isLegacyApiTokenScope detects the old vocabulary', () => {
	expect(isLegacyApiTokenScope('account:read')).toBe(true)
	expect(isLegacyApiTokenScope('local-execute')).toBe(true)
	expect(isLegacyApiTokenScope('org:read')).toBe(false)
	expect(isLegacyApiTokenScope(1)).toBe(false)
	for (const scope of Object.keys(legacyApiTokenScopeMap)) {
		expect(isLegacyApiTokenScope(scope)).toBe(true)
		for (const permission of legacyApiTokenScopeMap[
			scope as keyof typeof legacyApiTokenScopeMap
		]) {
			expect(isOrgPermission(permission)).toBe(true)
		}
	}
})
