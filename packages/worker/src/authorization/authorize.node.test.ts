import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	authorize,
	authorizeSurface,
	AuthorizationError,
	canSeeResource,
	checkPermission,
	computeEffectivePermissions,
	getRequestPermissions,
	reachedPackage,
	runWithRequestPermissions,
	type EffectivePermissions,
	type OrgResource,
} from './authorize.ts'

const mocks = vi.hoisted(() => ({
	resolveConnectionProfileGrants: vi.fn(),
}))

vi.mock('#worker/connection-profiles/repo.ts', () => ({
	resolveConnectionProfileGrants: (...args: Array<unknown>) =>
		mocks.resolveConnectionProfileGrants(...args),
}))

const env = { APP_DB: {} } as Env

function access(
	overrides: Partial<EffectivePermissions> = {},
): EffectivePermissions {
	return {
		orgId: ownerIdFromStored('org-1'),
		permissions: new Set(orgPermissions),
		credentialScopes: null,
		profileGrants: null,
		...overrides,
	}
}

function packageResource(overrides: Partial<OrgResource> = {}): OrgResource {
	return {
		type: 'package',
		id: 'pkg-1',
		orgId: ownerIdFromStored('org-1'),
		label: '@kent/invoices',
		...overrides,
	}
}

function denial(decision: ReturnType<typeof checkPermission>) {
	if (decision.allowed) throw new Error('Expected a denial.')
	return decision.error
}

test('every person owns their implicit org and holds every org permission in it', async () => {
	const request = sessionRequestContext('user-1')
	const effective = await computeEffectivePermissions({ env, request })

	expect(effective.orgId).toBe(personalOrgId(personIdFromStored('user-1')))
	expect(effective.credentialScopes).toBeNull()
	expect(effective.profileGrants).toBeNull()
	await expect(
		authorize({ env, request }, 'package:write', {
			type: 'package',
			id: 'pkg-1',
			orgId: request.org.id,
		}),
	).resolves.toBeUndefined()
})

test('Automation acts for its org with no actor', async () => {
	const request = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'schedule', jobId: 'job-1' },
	})
	expect(request.actor).toBeNull()
	await expect(
		authorize({ env, request }, 'job:execute'),
	).resolves.toBeUndefined()
})

test('a member holds only the role basics', async () => {
	const owner = sessionRequestContext('user-1')
	const member: RequestContext = { ...owner, membership: { role: 'member' } }
	const effective = await computeEffectivePermissions({
		env,
		request: member,
	})
	expect([...effective.permissions].sort()).toEqual([
		'member:read',
		'org:read',
		'search:read',
		'team:read',
	])
	const error = await authorize(
		{ env, request: member },
		'package:write',
	).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({
		code: 'missing_permission',
		permission: 'package:write',
		message: 'Missing package:write. An org Owner can grant it.',
	})
})

test('a resource in another org is denied before permissions are read', () => {
	const error = denial(
		checkPermission(
			access(),
			'package:read',
			packageResource({ orgId: ownerIdFromStored('org-2') }),
		),
	)
	expect(error.code).toBe('wrong_org')
	expect(error.message).toBe('package @kent/invoices belongs to another org.')
})

test('credential scopes narrow what the role grants', () => {
	const scoped = access({ credentialScopes: new Set(['package:read']) })
	expect(checkPermission(scoped, 'package:read').allowed).toBe(true)
	const error = denial(
		checkPermission(scoped, 'package:write', packageResource()),
	)
	expect(error.code).toBe('credential_scope')
	expect(error.message).toBe(
		'This credential is not scoped for package:write on package @kent/invoices.',
	)
})

test('a connection profile narrows the package resources it lists', () => {
	const profiled = access({
		profileGrants: [
			{ resourceType: 'package', resourceId: 'pkg-1', actions: ['read'] },
		],
	})
	expect(
		checkPermission(profiled, 'package:read', packageResource()).allowed,
	).toBe(true)
	const executeDenied = denial(
		checkPermission(
			profiled,
			'package:execute',
			packageResource({ label: undefined }),
		),
	)
	expect(executeDenied.code).toBe('connection_profile')
	expect(executeDenied.message).toBe(
		'This connection profile cannot execute package "pkg-1".',
	)
	expect(
		checkPermission(
			profiled,
			'package:read',
			packageResource({ id: 'pkg-2', label: undefined }),
		).allowed,
	).toBe(false)
	// Profiles list packages only, so other resources and org-level checks
	// are left to the role and credential.
	expect(checkPermission(profiled, 'package:read').allowed).toBe(true)
	expect(
		checkPermission(profiled, 'secret:use', {
			type: 'secret',
			id: 'token',
			orgId: ownerIdFromStored('org-1'),
		}).allowed,
	).toBe(true)
})

test('a request with no signed-in person is denied unless the surface touches no org data', async () => {
	const error = await authorize({ env, request: null }, 'package:read').catch(
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ code: 'unauthenticated', orgId: null })
	await expect(
		authorizeSurface({ env, request: null }, 'none'),
	).resolves.toBeUndefined()
	await expect(
		authorizeSurface({ env, request: null }, 'package:read'),
	).rejects.toBeInstanceOf(AuthorizationError)
})

test('lists show a package when the request holds any permission on it', () => {
	const pkg = reachedPackage(ownerIdFromStored('org-1'), { id: 'pkg-1' })
	expect(canSeeResource(access(), pkg)).toBe(true)
	const executeOnly = access({
		profileGrants: [
			{ resourceType: 'package', resourceId: 'pkg-1', actions: ['execute'] },
		],
	})
	expect(canSeeResource(executeOnly, pkg)).toBe(true)
	expect(checkPermission(executeOnly, 'package:read', pkg).allowed).toBe(false)
	expect(canSeeResource(access({ profileGrants: [] }), pkg)).toBe(false)
	expect(
		canSeeResource(
			access(),
			reachedPackage(ownerIdFromStored('org-2'), { id: 'pkg-1' }),
		),
	).toBe(false)
})

test('Automation keeps the connection profile of the credential that created it', async () => {
	const grants = [
		{ resourceType: 'package', resourceId: 'pkg-1', actions: ['read'] },
	]
	mocks.resolveConnectionProfileGrants.mockResolvedValueOnce(grants)
	const request = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'schedule', jobId: 'job-1' },
		profileName: ' work ',
	})
	const effective = await computeEffectivePermissions({ env, request })
	expect(mocks.resolveConnectionProfileGrants).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
		profileName: 'work',
	})
	expect(effective.profileGrants).toEqual(grants)
})

test('deep call sites read the permissions bound for the request', async () => {
	const request = sessionRequestContext('user-1')
	const bound = await runWithRequestPermissions({ env, request }, async () =>
		getRequestPermissions(),
	)
	expect(bound).toBe(await computeEffectivePermissions({ env, request }))
	await expect(
		runWithRequestPermissions({ env, request: null }, async () =>
			getRequestPermissions(),
		),
	).resolves.toBeUndefined()
})
