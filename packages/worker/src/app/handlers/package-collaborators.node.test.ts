import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	type PackageCollaboratorsChange,
	type PackageCollaboratorsWriteResult,
} from '#universal/package-collaborators.ts'
import {
	type CollaboratorPerson,
	collaboratorPeople,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	resolveSavedPackage: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

const { createPackageCollaboratorsApiHandler } =
	await import('./package-collaborators.ts')

let seed: PackageCollaboratorsSeed

beforeEach(async () => {
	seed = await seedPackageCollaborators()
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.resolveSavedPackage.mockReset()
	mocks.resolveSavedPackage.mockImplementation(
		async (input: { userId: string; packageIdOrKodyId: string }) =>
			seed.savedPackages.find(
				(savedPackage) =>
					savedPackage.userId === input.userId &&
					savedPackage.kodyId === input.packageIdOrKodyId,
			) ?? null,
	)
})

function signIn(person: CollaboratorPerson) {
	const { id, personId } = collaboratorPeople[person]
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		userId: id,
		username: person,
		email: `${person}@example.com`,
		mcpUser: {
			userId: personIdFromStored(personId),
			username: person,
			email: `${person}@example.com`,
			displayName: person,
		},
	})
}

const path =
	'https://kody.test/profiles/zeta-co/packages/demo-package/collaborators.json'

async function call(
	person: CollaboratorPerson,
	change?: PackageCollaboratorsChange | Record<string, unknown>,
) {
	signIn(person)
	const request = change
		? new Request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(change),
			})
		: new Request(path)
	const response = await createPackageCollaboratorsApiHandler({
		APP_DB: seed.db,
		AUDIT_DB: seed.auditDb,
	} as Env).handler({
		request,
		params: { username: 'zeta-co', kodyId: 'demo-package' },
	} as never)
	return {
		status: response.status,
		body: (await response.json()) as
			| PackageCollaboratorsWriteResult
			| { ok: false; error: string },
	}
}

function view(result: Awaited<ReturnType<typeof call>>) {
	if (!result.body.ok) throw new Error(result.body.error)
	return result.body
}

async function auditActions() {
	const rows = await seed.auditDb
		.prepare(`SELECT action FROM org_audit_events ORDER BY created_at, rowid`)
		.all<{ action: string }>()
	return rows.results.map((row) => row.action)
}

test('an owner sees the teams and members they can add', async () => {
	const loaded = view(await call('ada'))
	expect(loaded.org).toEqual({ slug: 'zeta-co', personal: false })
	expect(loaded.collaborators).toEqual([])
	expect(loaded.options.teams.map((team) => team.slug)).toEqual(['design'])
	expect(loaded.options.members.map((member) => member.username)).toEqual([
		'bob',
	])
})

test('grant, change preset, invite, revoke invite, and revoke are audited', async () => {
	const teamAdded = view(
		await call('ada', {
			intent: 'grant',
			subjectType: 'team',
			subjectId: 'team-design',
			preset: 'contribute',
		}),
	)
	expect(teamAdded.collaborators).toEqual([
		expect.objectContaining({
			kind: 'team',
			label: 'Design',
			preset: 'contribute',
		}),
	])
	expect(teamAdded.options.teams).toEqual([])

	view(
		await call('ada', {
			intent: 'grant',
			subjectType: 'user',
			subjectId: collaboratorPeople.bob.personId,
			preset: 'use',
		}),
	)
	const changed = view(
		await call('ada', {
			intent: 'grant',
			subjectType: 'user',
			subjectId: collaboratorPeople.bob.personId,
			preset: 'manage',
		}),
	)
	const bob = changed.collaborators.find(
		(collaborator) => collaborator.username === 'bob',
	)
	expect(bob).toMatchObject({
		kind: 'member',
		label: '@bob',
		displayName: 'Bob Builder',
		preset: 'manage',
	})
	expect(changed.collaborators).toHaveLength(2)

	const invited = view(
		await call('ada', { intent: 'invite', invitee: '@dan', preset: 'use' }),
	)
	expect(invited.invite?.token).toMatch(/\S+/)
	expect(invited.invite?.prompt).toContain(invited.invite!.token)
	expect(invited.invites).toEqual([
		expect.objectContaining({ inviteeUsername: 'dan', preset: 'use' }),
	])

	const revokedInvite = view(
		await call('ada', {
			intent: 'revoke-invite',
			inviteId: invited.invites[0]!.id,
		}),
	)
	expect(revokedInvite.invites).toEqual([])

	const removed = view(
		await call('ada', { intent: 'revoke', grantId: bob!.grantId }),
	)
	expect(removed.collaborators.map((row) => row.kind)).toEqual(['team'])

	expect(await auditActions()).toEqual([
		'grant.created',
		'grant.created',
		'grant.updated',
		'invite.created',
		'invite.revoked',
		'grant.revoked',
	])
})

test('a non-member must be invited, not granted directly', async () => {
	const refused = await call('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(refused.status).toBe(400)
	expect(refused.body).toMatchObject({ ok: false, error: /Invite them/ })
	expect(await auditActions()).toEqual([])
})

test('an outside collaborator who already holds a grant can have it changed', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	const changed = view(
		await call('ada', {
			intent: 'grant',
			subjectType: 'user',
			subjectId: collaboratorPeople.dan.personId,
			preset: 'contribute',
		}),
	)
	expect(changed.collaborators).toEqual([
		expect.objectContaining({
			grantId: 'grant-dan',
			kind: 'outside',
			preset: 'contribute',
		}),
	])
})

test('grants and invites on another package cannot be revoked here', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	const revoke = await call('ada', { intent: 'revoke', grantId: 'grant-other' })
	expect(revoke.status).toBe(404)
	const live = await seed.db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'grant-other'`)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()

	const revokeInvite = await call('ada', {
		intent: 'revoke-invite',
		inviteId: 'missing-invite',
	})
	expect(revokeInvite.status).toBe(404)
})

test('Manage is required; without read the package is not found', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	const forbidden = await call('bob')
	expect(forbidden.status).toBe(403)
	expect(forbidden.body).toMatchObject({ ok: false, error: /Manage/ })
	const forbiddenWrite = await call('bob', {
		intent: 'revoke',
		grantId: 'grant-bob',
	})
	expect(forbiddenWrite.status).toBe(403)

	expect((await call('erin')).status).toBe(404)

	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	const outsideManager = view(await call('dan'))
	expect(outsideManager.collaborators.map((row) => row.username)).toEqual([
		'bob',
		'dan',
	])
})

test('a malformed change is rejected', async () => {
	const result = await call('ada', { intent: 'grant', subjectType: 'user' })
	expect(result.status).toBe(400)
	expect(result.body).toMatchObject({ ok: false })
})
