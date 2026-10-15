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
					(savedPackage.id === input.packageIdOrKodyId ||
						savedPackage.kodyId === input.packageIdOrKodyId),
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

async function call(
	person: CollaboratorPerson,
	change?: PackageCollaboratorsChange | Record<string, unknown>,
	target: { username: string; kodyId: string } = {
		username: 'zeta-co',
		kodyId: 'demo-package',
	},
) {
	signIn(person)
	const path = `https://kody.test/profiles/${target.username}/packages/${target.kodyId}/collaborators.json`
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
		params: target,
	} as never)
	return {
		status: response.status,
		body: (await response.json()) as
			| PackageCollaboratorsWriteResult
			| { ok: false; error: string },
	}
}

const personalPackage = { username: 'ada', kodyId: 'ada-tools' }

/** `ada-tools` in ada's personal org, resolvable by the mocked lookup. */
async function addPersonalPackage() {
	const org = await seed.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'ada'`)
		.first<{ id: string }>()
	if (!org) throw new Error('ada has no personal org.')
	seed.savedPackages.push({
		id: 'pkg-ada',
		kodyId: 'ada-tools',
		name: 'ada-tools',
		userId: org.id,
	})
	return org.id
}

async function callPersonal(
	change?: PackageCollaboratorsChange | Record<string, unknown>,
) {
	return await call('ada', change, personalPackage)
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
	expect(loaded.invites).toEqual([])
	expect(loaded.options.teams.map((team) => team.slug)).toEqual(['design'])
	expect(loaded.options.members.map((member) => member.username)).toEqual([
		'bob',
	])
})

test('adding a team and a member, changing a preset, and removing are audited', async () => {
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

	const removed = view(
		await call('ada', { intent: 'revoke', grantId: bob!.grantId }),
	)
	expect(removed.collaborators.map((row) => row.kind)).toEqual(['team'])

	expect(await auditActions()).toEqual([
		'grant.created',
		'grant.created',
		'grant.updated',
		'grant.revoked',
	])
})

test('a non-member cannot be added', async () => {
	const refused = await call('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(refused.status).toBe(400)
	expect(refused.body).toMatchObject({
		ok: false,
		error: /not a member of this organization/,
	})
	expect(await auditActions()).toEqual([])
})

test('an outside collaborator is listed and can be removed but not changed', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(view(await call('ada')).collaborators).toEqual([
		expect.objectContaining({ grantId: 'grant-dan', kind: 'outside' }),
	])
	const refused = await call('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'contribute',
	})
	expect(refused.status).toBe(400)
	const removed = view(
		await call('ada', { intent: 'revoke', grantId: 'grant-dan' }),
	)
	expect(removed.collaborators).toEqual([])
	expect(await auditActions()).toEqual(['grant.revoked'])
})

test('invite changes are not accepted in a team org', async () => {
	const result = await call('ada', {
		intent: 'invite',
		invitee: '@dan',
		preset: 'use',
	})
	expect(result.status).toBe(400)
	expect(result.body).toMatchObject({ error: /personal organizations/ })
	const invites = await seed.db
		.prepare(`SELECT COUNT(*) AS count FROM invites`)
		.first<{ count: number }>()
	expect(invites?.count).toBe(0)
	const revoke = await call('ada', {
		intent: 'revoke-invite',
		inviteId: 'invite-1',
	})
	expect(revoke.status).toBe(400)
	expect(await auditActions()).toEqual([])
})

test('a personal org owner invites by username, sees it pending, and revokes it', async () => {
	await addPersonalPackage()
	const loaded = view(await callPersonal())
	expect(loaded.org).toEqual({ slug: 'ada', personal: true })
	expect(loaded.collaborators).toEqual([])
	expect(loaded.invites).toEqual([])

	const invited = view(
		await callPersonal({
			intent: 'invite',
			invitee: '@dan',
			preset: 'contribute',
		}),
	)
	expect(invited.invite).toMatchObject({
		inviteeLabel: '@dan',
		preset: 'contribute',
		prompt: expect.stringMatching(/Call inviteAccept with this token: \w+/),
	})
	expect(invited.invites).toEqual([
		expect.objectContaining({
			inviteeUsername: 'dan',
			inviteeEmail: null,
			preset: 'contribute',
		}),
	])
	expect(invited.invite?.id).toBe(invited.invites[0]!.id)
	const stored = await seed.db
		.prepare(
			`SELECT kind, resource_type, resource_id, preset FROM invites WHERE id = ?`,
		)
		.bind(invited.invites[0]!.id)
		.first()
	expect(stored).toEqual({
		kind: 'grant',
		resource_type: 'package',
		resource_id: 'pkg-ada',
		preset: 'contribute',
	})

	const reloaded = view(await callPersonal())
	expect(reloaded.invite).toBeUndefined()
	expect(reloaded.invites).toHaveLength(1)

	const revoked = view(
		await callPersonal({
			intent: 'revoke-invite',
			inviteId: invited.invites[0]!.id,
		}),
	)
	expect(revoked.invites).toEqual([])
	expect(await auditActions()).toEqual(['invite.created', 'invite.revoked'])

	const again = await callPersonal({
		intent: 'revoke-invite',
		inviteId: invited.invites[0]!.id,
	})
	expect(again.status).toBe(404)
	expect(again.body).toMatchObject({ error: /no longer pending/ })
})

test('a personal invite takes an email, and refuses a malformed username', async () => {
	await addPersonalPackage()
	const invited = view(
		await callPersonal({
			intent: 'invite',
			invitee: 'Jesse@Example.com',
			preset: 'use',
		}),
	)
	expect(invited.invite?.inviteeLabel).toBe('jesse@example.com')
	expect(invited.invites).toEqual([
		expect.objectContaining({
			inviteeEmail: 'jesse@example.com',
			inviteeUsername: null,
			preset: 'use',
		}),
	])

	const refused = await callPersonal({
		intent: 'invite',
		invitee: 'not a username!',
		preset: 'use',
	})
	expect(refused.status).toBe(400)
	expect(view(await callPersonal()).invites).toHaveLength(1)
})

test('a pending invite on another package cannot be revoked here', async () => {
	await addPersonalPackage()
	const orgId = (await seed.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'ada'`)
		.first<{ id: string }>())!.id
	seed.sqlite
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, resource_type, resource_id, preset,
			   invitee_username, token_hash, status, invited_by_user_id,
			   expires_at, created_at
			 ) VALUES ('invite-other', ?, 'grant', 'package', 'pkg-elsewhere', 'use',
			   'dan', 'hash', 'pending', ?, '2999-01-01T00:00:00.000Z', ?)`,
		)
		.run(orgId, collaboratorPeople.ada.personId, new Date().toISOString())
	expect(view(await callPersonal()).invites).toEqual([])
	const refused = await callPersonal({
		intent: 'revoke-invite',
		inviteId: 'invite-other',
	})
	expect(refused.status).toBe(404)
	const status = await seed.db
		.prepare(`SELECT status FROM invites WHERE id = 'invite-other'`)
		.first<{ status: string }>()
	expect(status?.status).toBe('pending')
})

test('a personal org outside collaborator is listed and can be removed', async () => {
	const orgId = await addPersonalPackage()
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-dan-personal', ?, 'package', 'pkg-ada', 'user', ?, 'use', ?, ?, ?)`,
		)
		.run(
			orgId,
			collaboratorPeople.dan.personId,
			collaboratorPeople.ada.personId,
			new Date().toISOString(),
			new Date().toISOString(),
		)
	seed.sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('grant-dan-personal', 'package:read'), ('grant-dan-personal', 'package:execute')`,
		)
		.run()
	expect(view(await callPersonal()).collaborators).toEqual([
		expect.objectContaining({
			grantId: 'grant-dan-personal',
			kind: 'outside',
			label: '@dan',
			preset: 'use',
		}),
	])
	const removed = view(
		await callPersonal({ intent: 'revoke', grantId: 'grant-dan-personal' }),
	)
	expect(removed.collaborators).toEqual([])
	expect(await auditActions()).toEqual(['grant.revoked'])
})

test('a grant on another package cannot be removed here', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	const revoke = await call('ada', { intent: 'revoke', grantId: 'grant-other' })
	expect(revoke.status).toBe(400)
	expect(revoke.body).toMatchObject({ error: /no longer has access/ })
	const live = await seed.db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'grant-other'`)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
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
