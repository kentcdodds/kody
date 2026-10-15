import { permissionsForGrantPreset } from '@kody-internal/shared/grant-presets.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { expect, test } from 'vitest'
import { resourceGrantKey } from '#worker/authorization/access-compile.ts'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { followAccessFromPermissions } from './access.ts'

const ownerId = ownerIdFromStored('org-owner')
const packageId = 'pkg-1'

function accessWith(
	permissions: ReadonlyArray<OrgPermission>,
): EffectivePermissions {
	return {
		orgId: ownerId,
		permissions: new Set(),
		isOwner: false,
		resourcePermissions: new Map([
			[resourceGrantKey('package', packageId), new Set(permissions)],
		]),
		credentialScopes: null,
		profileGrants: null,
	}
}

test('a use grant can follow and receive push; execute-only cannot', () => {
	const use = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: true,
		access: accessWith(permissionsForGrantPreset('package', 'use')),
		packageId,
		ownerId,
	})
	expect(use).toEqual({ canCreate: true, canPush: true })

	const executeOnly = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: true,
		access: accessWith(['package:execute']),
		packageId,
		ownerId,
	})
	expect(executeOnly).toEqual({ canCreate: false, canPush: false })

	const publicExecuteOnly = followAccessFromPermissions({
		targetKind: 'package',
		isPrivate: false,
		access: accessWith(['package:execute']),
		packageId,
		ownerId,
	})
	expect(publicExecuteOnly).toEqual({ canCreate: true, canPush: false })
})

test('a plain repo push requires org-wide package:read, not a single package grant', () => {
	const packageGrant = followAccessFromPermissions({
		targetKind: 'repo',
		isPrivate: false,
		access: accessWith(permissionsForGrantPreset('package', 'use')),
		packageId: null,
		ownerId,
	})
	expect(packageGrant).toEqual({ canCreate: true, canPush: false })

	const orgWide = followAccessFromPermissions({
		targetKind: 'repo',
		isPrivate: true,
		access: {
			orgId: ownerId,
			permissions: new Set(['package:read']),
			isOwner: false,
			resourcePermissions: new Map(),
			credentialScopes: null,
			profileGrants: null,
		},
		packageId: null,
		ownerId,
	})
	expect(orgWide).toEqual({ canCreate: true, canPush: true })
})
