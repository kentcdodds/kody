import { beforeEach, expect, test, vi } from 'vitest'
import {
	collaboratorCapabilityContext,
	collaboratorPeople,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const mocks = vi.hoisted(() => ({ resolveSavedPackage: vi.fn() }))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

const { packageCollaboratorListCapability } =
	await import('./package-collaborators.ts')

let seed: PackageCollaboratorsSeed

beforeEach(async () => {
	seed = await seedPackageCollaborators()
	mocks.resolveSavedPackage.mockReset()
	mocks.resolveSavedPackage.mockImplementation(
		async (input: { userId: string; packageIdOrKodyId: string }) =>
			seed.savedPackages.find(
				(savedPackage) =>
					savedPackage.userId === input.userId &&
					(savedPackage.id === input.packageIdOrKodyId ||
						savedPackage.kodyId === input.packageIdOrKodyId),
			) ?? null,
	)
})

test('lists team, member, and outside collaborators plus pending invites', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'contribute',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.erin.personId,
		preset: 'use',
	})
	seed.sqlite
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, token_hash, invitee_email, resource_type,
			   resource_id, preset, invited_by_user_id, status, expires_at, created_at
			 ) VALUES ('invite-1', ?, 'grant', 'hash', 'friend@example.com',
			   'package', 'pkg-1', 'use', ?, 'pending', '2999-01-01T00:00:00.000Z',
			   '2026-01-01T00:00:00.000Z')`,
		)
		.run(seed.orgId, collaboratorPeople.ada.personId)

	const result = await packageCollaboratorListCapability.handler(
		{ package_id: 'demo-package' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)

	expect(result.package).toEqual({
		id: 'pkg-1',
		kody_id: 'demo-package',
		name: 'demo-package',
	})
	expect(
		result.collaborators.map((collaborator) => ({
			grant_id: collaborator.grant_id,
			kind: collaborator.kind,
			username: collaborator.username,
			team_slug: collaborator.team_slug,
			preset: collaborator.preset,
		})),
	).toEqual([
		{
			grant_id: 'grant-team',
			kind: 'team',
			username: null,
			team_slug: 'design',
			preset: 'contribute',
		},
		{
			grant_id: 'grant-bob',
			kind: 'member',
			username: 'bob',
			team_slug: null,
			preset: 'use',
		},
		{
			grant_id: 'grant-dan',
			kind: 'outside',
			username: 'dan',
			team_slug: null,
			preset: 'manage',
		},
	])
	expect(result.invites).toEqual([
		expect.objectContaining({
			invite_id: 'invite-1',
			invitee_email: 'friend@example.com',
			preset: 'use',
		}),
	])
})

test('an outside collaborator with Manage can list; Use cannot', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-erin',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.erin.personId,
		preset: 'use',
	})

	const listed = await packageCollaboratorListCapability.handler(
		{ package_id: 'pkg-1' },
		collaboratorCapabilityContext(seed, 'dan', null),
	)
	expect(listed.collaborators.map((row) => row.username)).toEqual([
		'dan',
		'erin',
	])

	await expect(
		packageCollaboratorListCapability.handler(
			{ package_id: 'pkg-1' },
			collaboratorCapabilityContext(seed, 'erin', null),
		),
	).rejects.toThrow(/manage_access/)
})

test('an unknown package is not found', async () => {
	await expect(
		packageCollaboratorListCapability.handler(
			{ package_id: 'missing' },
			collaboratorCapabilityContext(seed, 'ada', 'owner'),
		),
	).rejects.toThrow('Package was not found in this organization.')
})
